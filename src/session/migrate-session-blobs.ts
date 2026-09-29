import { BLOB_OUTPUT_THRESHOLD_CHARS } from "../compressor/result-compressor.js";
import type { BlobStore } from "./blob-store.js";
import type { LatestResult, SessionState } from "./session-state.js";

/** Preserve the text still present in legacy sessions before shortening it. */
export function migrateSessionBlobs(
  state: SessionState,
  blobs: BlobStore,
): SessionState {
  let changed = false;
  const migrate = <T extends LatestResult>(result: T): T => {
    if (
      result.blob !== undefined ||
      typeof result.summary !== "string" ||
      result.summary.length <= BLOB_OUTPUT_THRESHOLD_CHARS ||
      ["reply", "finish", "tool.recall"].includes(result.tool)
    ) return result;
    const blob = blobs.putSync(result.summary);
    changed = true;
    return {
      ...result,
      blob,
      summary: result.summary.slice(0, BLOB_OUTPUT_THRESHOLD_CHARS),
      truncated: true,
    };
  };
  const turns = state.turns.map((turn) =>
    turn?.kind === "tool_result" ? migrate(turn) : turn,
  );
  const latestResult = state.latestResult ? migrate(state.latestResult) : null;
  return changed ? { ...state, turns, latestResult } : state;
}
