// Symbols survive tool wrappers that spread results, but never JSON serialization.
// The registry consumes this transient body before emitting or saving the result.
export const RAW_TOOL_OUTPUT = Symbol("rawToolOutput");
export const BLOB_OUTPUT_THRESHOLD_CHARS = 8_000;
/**
 * Below this size, eliding is a bad trade: it buys ~200 chars of budget and
 * costs the reader the middle of a 20-line diff. Outputs under it are passed
 * through whole, so nothing is ever "elided" for nothing.
 */
export const MIN_ELIDE_CHARS = 2_000;

export interface RawToolResult {
  tool: string;
  status: "ok" | "error";
  output: string;
  details?: Record<string, unknown>;
}

export interface CompressedToolResult {
  tool: string;
  status: "ok" | "error";
  summary: string;
  details: Record<string, unknown>;
  truncated: boolean;
  blob?: string;
  /** Character offset of a recalled page within its blob. */
  blobOffset?: number;
  [RAW_TOOL_OUTPUT]?: string;
}

export interface CompressorOptions {
  maxSummaryLength: number;
  maxTailLines: number;
  /** Source reads must preserve blank lines and indentation. */
  preserveWhitespace?: boolean;
  /**
   * Lines matching this pattern are always retained, even when they fall
   * outside the kept tail — failure/error lines live near the bottom of a
   * log and head-slicing silently erases them.
   */
  keepPattern?: RegExp;
}

/**
 * Default keep pattern for tool results: the lines that say what failed,
 * so compressing a test/log dump cannot hide a failure.
 */
export const TOOL_RESULT_KEEP_PATTERN =
  /(FAIL|Error|AssertionError|Expected|Received|Traceback|denied|ENOENT|timed out|×|✗|Test Files|Tests )/;

/**
 * Section headers, banners, separators and `label:` lines. A tail-only slice
 * keeps the end of a multi-section result and silently loses every heading in
 * the middle, so the output reads as one nameless block (one `ls` per
 * directory, one `git status` per repo, per-venue summary lines). Headers are
 * cheap, so they are retained wherever they sit, in their original position.
 */
export const TOOL_RESULT_STRUCTURE_PATTERN =
  /^(?:#{1,4}\s|[-=*#]{2,}.*[-=*#]{2,}$|[-=]{3,}$|\$ |exit: |\[[^\]]{1,80}\]$|\S[^\n]{0,58}:$)/;

/**
 * Default budget = the render cap, NOT a summary length. Callers that want a
 * deliberately short body pass `maxSummaryLength` explicitly (mcp projections,
 * refusal messages); a tool that simply returns its output gets the output.
 *
 * Measured 2026-10-27: the default was 400 chars, so every tool calling
 * `compressToolResult({tool, status, output})` — os.fs.edit among them — had
 * its result shredded at CREATION time, before the render layer could keep it
 * whole. Seven edits in one session read back as `… [N chars elided] …` with
 * 62–952 chars gone from the middle of the diff, and the blob pointer that
 * followed was the only copy of what had been written. Tools bound their own
 * output (edit preview 14 000, reads page, grep has headLimit); anything over
 * this cap still keeps head/tail and stores the full body for `tool.recall`.
 */
const DEFAULTS: CompressorOptions = {
  maxSummaryLength: 16_000,
  maxTailLines: 12,
};

/**
 * Shrinks verbose tool output (test logs, grep hits, stack traces) into a
 * compact summary that fits the latest-result budget. We keep the last N
 * non-blank lines plus a structured signal (counts, top hits, key error).
 */
export function compressToolResult(
  raw: RawToolResult,
  options: Partial<CompressorOptions> = {},
): CompressedToolResult {
  const merged = { ...DEFAULTS, ...options };
  const normalised = merged.preserveWhitespace
    ? raw.output
    : raw.output.replace(/\r\n/g, "\n").trimEnd();
  const worthEliding = normalised.length > MIN_ELIDE_CHARS;
  const { text: tail, truncated: tailTruncated } = merged.preserveWhitespace || !worthEliding
    ? { text: normalised, truncated: false }
    : extractTail(
        normalised,
        merged.maxTailLines,
        merged.keepPattern,
        merged.maxSummaryLength,
      );
  const signature = extractSignature(normalised, raw.status);
  const summaryParts = [signature, tail].filter((part) => part.length > 0);
  const joined = summaryParts.join("\n");
  const overLength = joined.length > merged.maxSummaryLength;
  const summary = overLength
    ? clipKeepingBothEnds(joined, merged.maxSummaryLength)
    : joined;
  return {
    tool: raw.tool,
    status: raw.status,
    summary,
    details: raw.details ?? {},
    truncated: tailTruncated || overLength,
    // Anything dropped must stay recoverable: the registry stores this body as a
    // blob and appends the `tool.recall` pointer. Gating it on 8_000 chars meant
    // a 4 KB result was elided at 12 lines with the middle stored NOWHERE — the
    // reader sees a marker and can never get the data back.
    ...(tailTruncated || overLength || raw.output.length > BLOB_OUTPUT_THRESHOLD_CHARS
      ? { [RAW_TOOL_OUTPUT]: raw.output }
      : {}),
  };
}

function extractTail(
  text: string,
  maxLines: number,
  keepPattern?: RegExp,
  budgetChars = Number.POSITIVE_INFINITY,
): { text: string; truncated: boolean } {
  if (text.length === 0) return { text: "", truncated: false };
  // Elision is for output that cannot fit, not for output that is merely tall.
  // This used to slice purely on line count, so a 60-line `sed`/`docker inspect`
  // dump lost its middle while sitting far inside the 16 000-char render cap —
  // the reader saw `… [36 lines elided] …` and had to re-run the command to get
  // data that was already in hand.
  if (text.length <= budgetChars) return { text, truncated: false };
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length <= maxLines)
    return { text: lines.join("\n"), truncated: false };
  const tailStart = lines.length - maxLines;
  // Keep the tail, plus any line above the tail that matters on its own: a
  // failure line (keepPattern) or a section header (structure). Kept lines are
  // emitted in their original order with a gap marker where lines were
  // dropped — hoisting kept lines to the front, as this used to, made the
  // output read as one nameless block and hid the middle of every
  // multi-section result.
  const kept = new Set<number>();
  for (let i = tailStart; i < lines.length; i += 1) kept.add(i);
  for (let i = 0; i < tailStart; i += 1) {
    const line = lines[i]!;
    if (
      TOOL_RESULT_STRUCTURE_PATTERN.test(line) ||
      (keepPattern !== undefined && keepPattern.test(line))
    ) {
      kept.add(i);
    }
  }
  const word = keepPattern === undefined ? "omitted" : "elided";
  const out: string[] = [];
  let gap = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (kept.has(i)) {
      if (gap > 0) out.push(`… [${gap} lines ${word}]`);
      gap = 0;
      out.push(lines[i]!);
      continue;
    }
    gap += 1;
  }
  if (gap > 0) out.push(`… [${gap} lines ${word}]`);
  return { text: out.join("\n"), truncated: true };
}

/**
 * Char backstop for an already line-elided summary. Head-slicing (what this
 * replaced) kept the signature and dropped the newest lines; tail-slicing
 * would keep the newest lines and drop the failure lines kept above them.
 * Keep both ends and say what went.
 *
 * ponytail: fixed 40/60 split. Ceiling: if this fires on most results the tail
 * budget is too large, not this function too small — cap lines, not chars.
 */
function clipKeepingBothEnds(text: string, budget: number): string {
  const head = Math.floor(budget * 0.4);
  const marker = `\n… [${text.length - budget} chars elided] …\n`;
  const tail = budget - head - marker.length;
  // A budget too small to hold head + marker leaves nothing to slice: `slice(-0)`
  // is the whole string, which would return the text uncapped. Emit the head and
  // the marker instead.
  if (tail <= 0) return `${text.slice(0, Math.max(0, budget - marker.length))}${marker}`;
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

const ERROR_MARKERS = [
  /error:/i,
  /failed:/i,
  /traceback \(most recent call last\)/i,
  /assertionerror/i,
  /exception:/i,
];

function extractSignature(text: string, status: "ok" | "error"): string {
  if (status === "ok") return "";
  const lines = text.split("\n");
  for (const line of lines) {
    for (const pattern of ERROR_MARKERS) {
      if (pattern.test(line)) {
        return `key: ${line.trim().slice(0, 180)}`;
      }
    }
  }
  return "";
}
