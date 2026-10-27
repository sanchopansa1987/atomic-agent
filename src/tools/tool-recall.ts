import type { BlobStore } from "../session/blob-store.js";
import type { ToolDefinition } from "./tool-registry.js";

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_RECALL_CHARS = 8_000;

export function buildToolRecallTool(blobStore: BlobStore): ToolDefinition {
  return {
    name: "tool.recall",
    description:
      "Page a stored output by its 64-char SHA-256 hash (never a numeric row id); continue with the returned offset. To read a memory/procedure row by numeric id, call memory.procedures.recall instead.",
    readonly: true,
    async run(rawArgs) {
      let hash = rawArgs.blob;
      // A truncated hash is still a pointer: `[truncated]` was unreadable
      // whenever the renderer shortened the 64-char id, so an 8+ char prefix
      // resolves to the one blob it names. Ambiguity is reported, not guessed.
      if (typeof hash === "string" && /^[a-f0-9]{8,63}$/i.test(hash.trim())) {
        hash = (await blobStore.resolvePrefix(hash)) ?? hash;
      }
      // Root-cause fix for a real no-progress loop (2026-10-23): `tool.recall`
      // pages a stored output blob by hash, but "recall" kept getting called
      // with a numeric memory/procedure id (e.g. 2889), which belongs to
      // `memory.procedures.recall`. The old message named the shape but not the
      // tool, so the caller re-rolled the argument instead of switching tools.
      // A valid 64-char hash passes straight through; anything that looks like a
      // row id (numeric, or hex-shaped but short of a hash) is routed, so the
      // repair is always "switch tools", never "re-roll the arg".
      if (!(typeof hash === "string" && HASH_RE.test(hash))) {
        const numericId =
          typeof hash === "number"
            ? String(hash)
            : typeof hash === "string" && /^\d+$/.test(hash)
              ? hash
              : null;
        if (numericId !== null) {
          throw new Error(
            `tool.recall pages a stored output by its 64-char SHA-256 hash, not a row id. ` +
              `To read memory/procedure row ${numericId}, call ` +
              `memory.procedures.recall { id: ${numericId} } instead.`,
          );
        }
        if (typeof hash === "string" && /^[0-9a-f]{1,63}$/.test(hash)) {
          throw new Error(
            `tool.recall pages a stored output by its 64-char SHA-256 hash, not a row id. ` +
              `"${hash}" looks like a hex row reference, but memory/procedure ids are numeric — ` +
              `call memory.procedures.recall { id: <number> } instead.`,
          );
        }
        throw new Error(
          "tool.recall: `blob` must be a 64-character lowercase SHA-256 hash",
        );
      }

      const offset = rawArgs.offset === undefined ? 0 : rawArgs.offset;
      const limit = rawArgs.limit === undefined ? MAX_RECALL_CHARS : rawArgs.limit;
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
        throw new Error("tool.recall: `offset` must be a non-negative integer");
      }
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECALL_CHARS) {
        throw new Error(`tool.recall: \`limit\` must be an integer from 1 to ${MAX_RECALL_CHARS}`);
      }

      const content = await blobStore.get(hash);
      if (content === null) {
        throw new Error(
          `tool.recall: blob not found: ${hash}. ` +
            `If you meant to read a memory/procedure row by numeric id, call memory.procedures.recall instead.`,
        );
      }
      if (offset > content.length) {
        throw new Error(`tool.recall: offset ${offset} is past the end (${content.length} characters)`);
      }
      const end = Math.min(content.length, offset + limit);

      // The generic compressor removes blank lines and trailing whitespace.
      // Recall preserves the saved text while bounding each returned page.
      return {
        tool: "tool.recall",
        status: "ok",
        summary: content.slice(offset, end),
        blob: hash,
        blobOffset: offset,
        details: {
          blob: hash,
          bytes: Buffer.byteLength(content, "utf8"),
          offset,
          ...(end < content.length ? { nextOffset: end } : {}),
        },
        truncated: end < content.length,
      };
    },
  };
}
