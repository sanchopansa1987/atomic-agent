import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConversationTurn } from "../session/conversation-turn.js";

/**
 * Harness S6. The smallest per-turn quality score that can move. Four fields:
 *   - steps_used      the loop's step counter for the turn
 *   - tools_failed    tool_result turns with status "error"
 *   - claims_refused  total unverified-claim texts on this turn's replies
 *   - rework          a second edit to the same file counts 1 (extra edits beyond
 *                     the first per path)
 */
export interface TurnQuality {
  steps_used: number;
  tools_failed: number;
  claims_refused: number;
  rework: number;
}

/** Tools that rewrite one named file; `os.fs.patch` edits a directory, so it is out. */
const EDIT_TOOLS = new Set(["os.fs.edit", "os.fs.write"]);

function editPath(turn: ConversationTurn): string | null {
  if (turn.kind !== "assistant_tool_call") return null;
  if (!EDIT_TOOLS.has(turn.tool)) return null;
  const path = turn.args?.path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

export function computeTurnQuality(
  turns: readonly ConversationTurn[],
  stepsUsed: number,
): TurnQuality {
  let toolsFailed = 0;
  let claimsRefused = 0;
  const editsByPath = new Map<string, number>();
  for (const turn of turns) {
    if (turn.kind === "tool_result" && turn.status === "error") toolsFailed += 1;
    if (turn.kind === "assistant_reply" && turn.unverifiedClaims !== undefined) {
      claimsRefused += turn.unverifiedClaims.length;
    }
    const path = editPath(turn);
    if (path !== null) editsByPath.set(path, (editsByPath.get(path) ?? 0) + 1);
  }
  let rework = 0;
  for (const count of editsByPath.values()) rework += Math.max(0, count - 1);
  return {
    steps_used: stepsUsed,
    tools_failed: toolsFailed,
    claims_refused: claimsRefused,
    rework,
  };
}

/**
 * Append one JSONL row. `path` is the caller's `results/turn-quality.jsonl`;
 * the directory is created if missing. Advisory: throws are the caller's to
 * swallow — a quality-log write must never fail a turn.
 */
export function appendTurnQualityRow(
  path: string,
  metrics: TurnQuality,
): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(metrics) + "\n");
}

/** The quality file for a project, relative to its working directory. */
export function turnQualityPath(workingDir: string): string {
  return join(workingDir, "results", "turn-quality.jsonl");
}
