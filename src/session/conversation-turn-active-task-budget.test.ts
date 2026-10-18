import { describe, it, expect } from "vitest";
import {
  assistantToolCallTurn,
  packConversation,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "./conversation-turn.js";

/**
 * Regression for the active-task budget boundary: `packConversation` pins
 * the current macro-turn's opening user turn and the last user turn, and
 * keeps every complete tool call/result pair, so no cut may drop them. The
 * prompt defect was that when that protected slice *on its own* costs more
 * than the conversation cap, the packer still returned it silently —
 * `droppedCount` / `boundBy` said "history was trimmed", and the native
 * request the provider then received was oversized (one active task
 * retaining >32k reasoning tokens under a 32k budget, zero turns dropped).
 *
 * These tests pin the explicit over-budget state that lets the execution
 * boundary refuse to open that request instead of sending it.
 */
const BUDGET = 32_000;

/**
 * One active user task: 12 completed tool exchanges whose assistant turns
 * carry enough retained reasoning that the reasoning alone clears 32k
 * tokens. No `assistant_reply` closes the task, so the whole transcript is
 * the current macro-turn and every row is protected.
 */
function oneActiveTask(): ConversationTurn[] {
  const turns: ConversationTurn[] = [userTurn("run the long analysis", 1)];
  for (let i = 0; i < 12; i += 1) {
    turns.push(
      assistantToolCallTurn({
        tool: "os.fs.read",
        args: { path: `/tmp/step-${i}.ts`, offset: i, limit: 200 },
        reasoning: `deliberation ${i} `.repeat(1200),
        at: 2 + i * 2,
      }),
    );
    turns.push(
      toolResultTurn({
        tool: "os.fs.read",
        status: "ok",
        summary: `contents of step ${i}`,
        at: 3 + i * 2,
      }),
    );
  }
  return turns;
}

describe("packConversation flags an un-cuttable active task", () => {
  it("reports the protected slice when one active task exceeds the budget", () => {
    const turns = oneActiveTask();
    const packed = packConversation(turns, BUDGET);

    // Nothing else was there to drop — the oversized slice is the task.
    expect(packed.droppedCount).toBe(0);
    expect(packed.overBudget).not.toBeNull();
    expect(packed.overBudget?.requiredTokens).toBeGreaterThan(BUDGET);
    expect(packed.overBudget?.budget).toBe(BUDGET);
    expect(packed.overBudget?.protectedTurnCount).toBe(turns.length);
    // Required reasoning and complete call/result pairs stay in view: the
    // boundary reports, it never truncates protocol history.
    expect(packed.visibleTurns).toEqual(turns);
  });

  it("does not flag a task that fits the budget", () => {
    const turns = oneActiveTask().slice(0, 3);
    const packed = packConversation(turns, BUDGET);
    expect(packed.overBudget).toBeNull();
  });
});
