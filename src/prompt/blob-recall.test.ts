import { describe, expect, it } from "vitest";
import { capBatchSummaries } from "../agent/batch-summary-cap.js";
import { assistantReplyTurn, toolResultTurn } from "../session/conversation-turn.js";
import { packedConversationTurns, renderPackedConversation } from "./build-prompt-world-conversation.js";

describe("blob references in prompts", () => {
  it("keeps recall hints after history caps and distinguishes equal summaries with different originals", () => {
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    const summary = "text\n".repeat(3000);
    const packed = { visibleTurns: [
      toolResultTurn({ tool: "os.fs.read", status: "ok", summary, blob: first }),
      toolResultTurn({ tool: "os.fs.read", status: "ok", summary, blob: second }),
      assistantReplyTurn("done"),
    ], droppedSummary: null };
    const flat = renderPackedConversation(packed);
    const native = packedConversationTurns(packed);
    expect(flat).not.toContain("duplicate tool-result");
    for (const blob of [first, second]) {
      expect(flat).toContain(`tool.recall {"blob":"${blob}"}`);
    }
    for (const turn of native) {
      if (turn.kind !== "tool_result") continue;
      // READ_HISTORY_CAP_CHARS (8000) is the read history preview cap: a body
      // this size is the designed ceiling, not a leak. The old 2500 pin predated
      // raising it from 2000 and was red before the compressor default changed.
      expect(turn.body.length).toBeLessThanOrEqual(8_100);
      expect(flat).toContain(turn.body);
    }
  });

  it("continues from the visible prefix when a batch budget cuts a recalled page", () => {
    const blob = "c".repeat(64);
    const result = { tool: "tool.recall", summary: "0123456789".repeat(800), blob };
    const [summary] = capBatchSummaries([result, result], [{}, {}], 1200);
    expect(summary).toBe(result.summary.slice(0, 600));
    const packed = { visibleTurns: [toolResultTurn({
      ...result, status: "ok", summary: summary!, blobOffset: 7000, truncated: true,
    })], droppedSummary: null };
    const flat = renderPackedConversation(packed);
    expect(flat).toContain(`tool.recall {"blob":"${blob}","offset":7600}`);
    const native = packedConversationTurns(packed)[0]!;
    expect(native.kind).toBe("tool_result");
    if (native.kind === "tool_result") expect(flat).toContain(native.body);
  });
});
