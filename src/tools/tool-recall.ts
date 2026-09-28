import type { BlobStore } from "../session/blob-store.js";
import type { ToolDefinition } from "./tool-registry.js";

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_RECALL_CHARS = 64_000;

export function buildToolRecallTool(blobStore: BlobStore): ToolDefinition {
  return {
    name: "tool.recall",
    description: "Recall stored blob content verbatim, up to 64,000 characters.",
    readonly: true,
    async run(rawArgs) {
      const hash = rawArgs.blob;
      if (typeof hash !== "string" || !HASH_RE.test(hash)) {
        throw new Error(
          "tool.recall: `blob` must be a 64-character lowercase SHA-256 hash",
        );
      }

      const content = await blobStore.get(hash);
      if (content === null) {
        throw new Error(`tool.recall: blob not found: ${hash}`);
      }

      // The generic compressor removes blank lines and trailing whitespace.
      // Recall preserves the saved text while bounding the returned prefix.
      return {
        tool: "tool.recall",
        status: "ok",
        summary: content.slice(0, MAX_RECALL_CHARS),
        details: {
          blob: hash,
          bytes: Buffer.byteLength(content, "utf8"),
        },
        truncated: content.length > MAX_RECALL_CHARS,
      };
    },
  };
}
