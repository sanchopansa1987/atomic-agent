import type { BlobStore } from "../session/blob-store.js";
import type { ToolDefinition } from "./tool-registry.js";

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_RECALL_CHARS = 8_000;

export function buildToolRecallTool(blobStore: BlobStore): ToolDefinition {
  return {
    name: "tool.recall",
    description: "Read a stored output page verbatim; use its next offset to continue.",
    readonly: true,
    async run(rawArgs) {
      const hash = rawArgs.blob;
      if (typeof hash !== "string" || !HASH_RE.test(hash)) {
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
        throw new Error(`tool.recall: blob not found: ${hash}`);
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
