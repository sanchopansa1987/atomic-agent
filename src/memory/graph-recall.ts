import { execFileSync } from "node:child_process";
import { estimateTokens, truncateToTokens } from "../prompt/token-budget.js";

/** Hard ceiling for the `### graph` tail block. */
export const GRAPH_MAX_TOKENS = 200;
/** Hard ceiling on rendered lines (the report already runs short; belt + braces). */
export const GRAPH_MAX_LINES = 6;
/**
 * Silence ceiling: a brain-graph read slower than this is not worth a step's
 * latency. The read is advisory, so a slow/missing script degrades to "no block".
 */
export const GRAPH_TIMEOUT_MS = 300;

/**
 * Shell out to `brain_graph.py` and return its report trimmed to the `### graph`
 * budget, or `null` when the script is missing, slow (> timeout), errors, or
 * prints nothing. Never throws: a failed graph read must not fail a step.
 *
 * The report's first lines already carry the hubs and the connected components
 * (the "current cluster"), which is exactly what the block surfaces.
 */
export async function recallGraphSection(
  scriptPath: string,
  timeoutMs: number = GRAPH_TIMEOUT_MS,
): Promise<string | null> {
  try {
    // Synchronous on purpose: the caller awaits this once per turn, and a
    // promisified `execFile` would dangle on the child's real exit event —
    // which fake-timer tests never yield to. `execFileSync` blocks the thread
    // for at most `timeoutMs` (the advisory read's own ceiling).
    const stdout = execFileSync("python3", [scriptPath], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
      // Degrade silently: the missing-script traceback must not leak into the
      // agent's stderr or the test output.
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, GRAPH_MAX_LINES);
    if (lines.length === 0) return null;
    return truncateToTokens(lines.join("\n"), GRAPH_MAX_TOKENS);
  } catch {
    return null;
  }
}

/** Token estimate for the block budget, exported for the ordering/tail tests. */
export function estimateGraphTokens(body: string): number {
  return estimateTokens(body);
}
