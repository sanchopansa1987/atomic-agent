import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { open, realpath, stat } from "node:fs/promises";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "./expand-home.js";
import {
  hashReadContent,
  READ_COVERAGE_DETAIL_KEY,
  splitReadLines,
  type ReadCoverageDetail,
} from "./fs-read-coverage.js";
import type { ToolDefinition } from "../tool-registry.js";

const DEFAULT_MAX_BYTES = 8 * 1024;

/**
 * No line-level cap. The byte cap above is this tool's only limit, and it
 * is the one the description advertises ("increase `maxBytes` to reach
 * deeper into a large file"). A lower `maxTailLines` would silently drop
 * the START of a long read, leaving `… [omitted N lines]` with no hint on
 * how to reach those lines — the renderer's own cap already appends an
 * exact `offset`/`limit` paging hint instead.
 */
const READ_MAX_LINES = Number.MAX_SAFE_INTEGER;

interface ReadArgs {
  path: string;
  maxBytes: number;
  offset?: number;
  limit?: number;
  lineNumbers: boolean;
}

function parseArgs(rawArgs: Record<string, unknown>): ReadArgs {
  const path = rawArgs.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("os.fs.read: `path` must be a non-empty string");
  }
  const maxBytes =
    typeof rawArgs.maxBytes === "number" && Number.isFinite(rawArgs.maxBytes)
      ? Math.max(1, Math.floor(rawArgs.maxBytes))
      : DEFAULT_MAX_BYTES;
  const offset =
    typeof rawArgs.offset === "number" && Number.isFinite(rawArgs.offset)
      ? Math.trunc(rawArgs.offset)
      : undefined;
  const limit =
    typeof rawArgs.limit === "number" && Number.isFinite(rawArgs.limit)
      ? Math.max(0, Math.trunc(rawArgs.limit))
      : undefined;
  const lineNumbers = rawArgs.lineNumbers === true;
  return { path, maxBytes, offset, limit, lineNumbers };
}

export const osFsReadTool: ToolDefinition = {
  name: "os.fs.read",
  description:
    "Read a UTF-8 text file. Paths may be relative to the session working " +
    "directory. `offset` and `limit` select LINE numbers (1-based; negative " +
    "offset counts from the end), but only among the lines present in the " +
    "first `maxBytes` bytes of the file (default 8KB, up to the file size). " +
    "An `offset` past that readable-prefix raises an error naming the " +
    "readable line count — increase `maxBytes` to reach deeper into a large " +
    "file. Without an explicit maxBytes, nonnegative line ranges in large files " +
    "stream from the requested offset (default 200 lines, at most 8KB of text). " +
    "Use the returned nextOffset to continue. `lineNumbers: true` " +
    "prefixes each returned line with `N|`.",
  readonly: true,
  async run(rawArgs, ctx) {
    const args = parseArgs(rawArgs);
    const absolute = resolveUserPath(args.path, ctx.workingDir);
    const info = await stat(absolute);
    if (!info.isFile()) {
      throw new Error(`os.fs.read: ${absolute} is not a regular file`);
    }
    const canonical = await canonicalize(absolute);

    if (args.offset !== undefined || args.limit !== undefined) {
      if (rawArgs.maxBytes === undefined && info.size > DEFAULT_MAX_BYTES &&
          (args.offset ?? 1) >= 0) {
        return readLargeLineRange(absolute, canonical, info.size, args);
      }
      return readByLines(absolute, canonical, info.size, args);
    }
    return readByBytes(absolute, canonical, info.size, args);
  },
};

/**
 * Symlink-resolved path, used only as the read-coverage identity so that
 * two reads of one file through different links are recognized as the
 * same file. `details.path` keeps the unresolved absolute path the caller
 * asked for — it is what the model and the UI have been shown all along,
 * and rewriting it here would change every read's output.
 *
 * A failure (a race deleting the file between `stat` and here, a
 * permission wall on a parent directory) degrades to the unresolved path:
 * a slightly coarser identity is strictly better than failing a read that
 * has already succeeded.
 */
async function canonicalize(absolute: string): Promise<string> {
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

async function readByBytes(
  absolute: string,
  canonical: string,
  size: number,
  args: ReadArgs,
): Promise<ReturnType<typeof compressToolResult>> {
  const handle = await open(absolute, "r");
  try {
    const toRead = Math.min(size, args.maxBytes);
    const buffer = Buffer.alloc(toRead);
    if (toRead > 0) {
      await handle.read(buffer, 0, toRead, 0);
    }
    const truncated = size > args.maxBytes;
    const body = buffer.toString("utf8");
    const text = args.lineNumbers ? prefixLineNumbers(body, 1) : body;
    // Byte mode returns the whole (possibly byte-capped) prefix, so the
    // returned range is lines 1..N of it. The top-level `startLine` /
    // `totalLines` details stay absent here — byte-mode results have
    // never carried them and consumers distinguish the two modes by
    // exactly that — so the span is reported only inside the coverage
    // detail, where it exists for the detector rather than for display.
    const lineCount = splitReadLines(body).length;
    return compressToolResult(
      {
        tool: "os.fs.read",
        status: "ok",
        output: text,
        details: {
          path: absolute,
          size,
          truncated,
          bytesRead: toRead,
          [READ_COVERAGE_DETAIL_KEY]: coverage(canonical, buffer, args, {
            startLine: lineCount === 0 ? 0 : 1,
            endLine: lineCount,
            totalLines: lineCount,
            truncated,
          }),
        },
      },
      { maxSummaryLength: text.length + 1, maxTailLines: READ_MAX_LINES, preserveWhitespace: true },
    );
  } finally {
    await handle.close();
  }
}

async function readByLines(
  absolute: string,
  canonical: string,
  size: number,
  args: ReadArgs,
): Promise<ReturnType<typeof compressToolResult>> {
  const handle = await open(absolute, "r");
  let allLines: string[];
  let buffer: Buffer;
  try {
    const toRead = Math.min(size, args.maxBytes);
    buffer = Buffer.alloc(toRead);
    if (toRead > 0) {
      await handle.read(buffer, 0, toRead, 0);
    }
    allLines = splitReadLines(buffer.toString("utf8"));
  } finally {
    await handle.close();
  }

  const total = allLines.length;
  const { startIndex, limit } = resolveRange(total, args.offset, args.limit);
  // An offset past the readable prefix used to return empty output with no
  // explanation — the model then guessed whether the file was short, the
  // offset was wrong, or the tool was misbehaving. It cycled through several
  // interpretations across a dozen reasoning blocks. Raise instead, naming
  // the readable line count and the file's true size, so the next step is
  // unambiguous: increase maxBytes or drop the offset.
  if (total > 0 && startIndex >= total) {
    if (size <= args.maxBytes) {
      throw new Error(
        `os.fs.read: offset ${args.offset} is past the end of ${absolute}. ` +
          `The whole file was read (${size} bytes, ${total} lines). ` +
          `Use an offset within lines 1-${total}, ` +
          `or omit offset to read from the top of the file.`,
      );
    }
    const maxBytesCap = args.maxBytes;
    throw new Error(
      `os.fs.read: offset ${args.offset} is past the readable-prefix of ${absolute}. ` +
        `The file is ${size} bytes; this call reads at most ${maxBytesCap} bytes ` +
        `from the start, which contains ${total} lines. ` +
        `Pass a larger maxBytes (up to ${size}) to reach deeper lines, ` +
        `or omit offset to read from the top of the file.`,
    );
  }
  const sliced = allLines.slice(startIndex, startIndex + limit);
  const body = args.lineNumbers
    ? sliced
        .map((line, idx) => formatNumberedLine(startIndex + idx + 1, line))
        .join("\n")
    : sliced.join("\n");
  const readBytes = Math.min(size, args.maxBytes);
  const fileBytesTruncated = size > args.maxBytes;
  const linesTruncated = startIndex + sliced.length < total;
  return compressToolResult(
    {
      tool: "os.fs.read",
      status: "ok",
      output: body,
      details: {
        path: absolute,
        size,
        truncated: fileBytesTruncated || linesTruncated,
        bytesRead: readBytes,
        totalLines: total,
        startLine: total === 0 ? 0 : startIndex + 1,
        endLine: startIndex + sliced.length,
        returnedLines: sliced.length,
        // A read that returned nothing (empty file, or an offset past the
        // end) reports an empty 0/0 span rather than a range it did not
        // return — the detector must never credit coverage for lines the
        // model never saw.
        [READ_COVERAGE_DETAIL_KEY]: coverage(canonical, buffer, args, {
          startLine: sliced.length === 0 ? 0 : startIndex + 1,
          endLine: sliced.length === 0 ? 0 : startIndex + sliced.length,
          totalLines: total,
          // Deliberately NOT `truncated` from the details above: that one
          // also fires when the requested window merely ended before the
          // end of the readable prefix, which another offset can still
          // reach. The detector asks a narrower question — is there
          // content no range of this call could return? — and only the
          // byte cap makes that true.
          truncated: fileBytesTruncated,
        }),
      },
    },
    { maxSummaryLength: body.length + 1, maxTailLines: READ_MAX_LINES, preserveWhitespace: true },
  );
}

/** Scan without retaining the prefix; the byte budget applies to returned text. */
async function readLargeLineRange(
  absolute: string,
  canonical: string,
  size: number,
  args: ReadArgs,
): Promise<ReturnType<typeof compressToolResult>> {
  const first = Math.max(1, args.offset ?? 1);
  const limit = args.limit ?? 200;
  const stream = createReadStream(absolute);
  const hash = createHash("sha1");
  stream.on("data", (chunk) => hash.update(chunk));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const selected: string[] = [];
  let total = 0;
  let bytes = 0;
  let capped = false;
  try {
    for await (const line of lines) {
      total++;
      if (total < first || selected.length >= limit || capped) continue;
      const rendered = args.lineNumbers ? formatNumberedLine(total, line) : line;
      const length = Buffer.byteLength(rendered) + (selected.length ? 1 : 0);
      if (bytes + length > args.maxBytes) {
        if (selected.length === 0) {
          throw new Error("os.fs.read: requested line exceeds 8KB; use an explicit maxBytes large enough for its file prefix");
        }
        capped = true;
        continue;
      }
      selected.push(rendered);
      bytes += length;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (total > 0 && first > total) {
    throw new Error(`os.fs.read: offset ${first} is past the end of ${absolute} (${total} lines)`);
  }
  const end = selected.length ? first + selected.length - 1 : 0;
  const more = selected.length ? end < total : first <= total;
  const body = selected.join("\n");
  const output = capped || (args.limit === undefined && more)
    ? body + `\n[Read bounded; continue with offset: ${first + selected.length}, limit: 200]`
    : body;
  const result = compressToolResult({
    tool: "os.fs.read", status: "ok", output,
    details: {
      path: absolute, size, bytesRead: stream.bytesRead,
      truncated: more, totalLines: total,
      startLine: selected.length ? first : 0, endLine: end,
      returnedLines: selected.length, ...(more ? { nextOffset: first + selected.length } : {}),
      [READ_COVERAGE_DETAIL_KEY]: {
        path: canonical, contentHash: hash.digest("hex").slice(0, 16),
        numbered: args.lineNumbers, startLine: selected.length ? first : 0,
        endLine: end, totalLines: total, truncated: false,
      },
    },
  }, { maxSummaryLength: output.length + 1, maxTailLines: READ_MAX_LINES, preserveWhitespace: true });
  return result;
}

/** Assemble the read-coverage detail for one successful read. */
function coverage(
  canonical: string,
  bytesRead: Buffer,
  args: ReadArgs,
  span: Pick<
    ReadCoverageDetail,
    "startLine" | "endLine" | "totalLines" | "truncated"
  >,
): ReadCoverageDetail {
  return {
    path: canonical,
    contentHash: hashReadContent(bytesRead),
    numbered: args.lineNumbers,
    ...span,
  };
}

function resolveRange(
  total: number,
  offset: number | undefined,
  limit: number | undefined,
): { startIndex: number; limit: number } {
  if (total === 0) return { startIndex: 0, limit: 0 };
  let startIndex: number;
  if (offset === undefined) {
    startIndex = 0;
  } else if (offset < 0) {
    // -1 = last line. clamp so that we never go below zero.
    startIndex = Math.max(0, total + offset);
  } else if (offset === 0) {
    startIndex = 0;
  } else {
    startIndex = Math.min(total, offset - 1);
  }
  const effectiveLimit =
    limit === undefined
      ? total - startIndex
      : Math.min(limit, total - startIndex);
  return { startIndex, limit: Math.max(0, effectiveLimit) };
}

function prefixLineNumbers(text: string, firstLineNumber: number): string {
  const lines = text.split(/\r?\n/);
  return lines
    .map((line, idx) => formatNumberedLine(firstLineNumber + idx, line))
    .join("\n");
}

function formatNumberedLine(lineNumber: number, content: string): string {
  return `${String(lineNumber).padStart(6, " ")}|${content}`;
}
