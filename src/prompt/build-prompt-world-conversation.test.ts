import { describe, expect, it } from "vitest";
import {
  assistantReplyTurn,
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
} from "../session/conversation-turn.js";
import {
  packedConversationTurns,
  renderPackedConversation,
} from "./build-prompt-world-conversation.js";

// 800 lines × ~36 chars ≈ 29 KB: comfortably past TOOL_RESULT_RENDER_CAP_CHARS
// (16 000) so the paging-hint tests actually exercise a cut. At 300 lines the
// body fit under the raised cap and those tests asserted on a render with no
// truncation in it — green-by-accident data, red as soon as it mattered.
const bigFile = Array.from(
  { length: 800 },
  (_, i) => `line ${i + 1} ${"y".repeat(30)}`,
).join("\n");

function readCall(args: Record<string, unknown>, at: number) {
  return assistantToolCallTurn({ tool: "os.fs.read", args, at });
}

function readResult(at: number, summary = bigFile) {
  return toolResultTurn({
    tool: "os.fs.read",
    status: "ok",
    summary,
    at,
  });
}

function pagingHints(rendered: string): { shown: number; next: string }[] {
  return [
    ...rendered.matchAll(
      /prompt shows the first (\d+) lines of this read.*?call os\.fs\.read with (offset: \d+|the line after the last one shown as `offset`)/g,
    ),
  ].map((m) => ({ shown: Number(m[1]), next: m[2]! }));
}

describe("renderPackedConversation", () => {
  it("names the offset after the range each os.fs.read started at, in call order", () => {
    const rendered = renderPackedConversation({
      visibleTurns: [
        userTurn("review the game", 1),
        readCall({ path: "js/main.js" }, 2),
        readCall({ path: "js/ship.js", offset: 101, limit: 300 }, 3),
        readResult(4),
        readResult(5),
      ],
      droppedSummary: null,
    });
    const [first, second] = pagingHints(rendered);
    expect(first!.next).toBe(`offset: ${first!.shown + 1}`);
    expect(second!.next).toBe(`offset: ${second!.shown + 101}`);
  });

  it("leaves the offset unnamed when it cannot be known", () => {
    const rendered = renderPackedConversation({
      visibleTurns: [
        // Counted from the end of a file whose length the renderer does not know.
        readCall({ path: "js/main.js", offset: -300 }, 1),
        readResult(2),
        assistantReplyTurn("done", 3),
        // No call in view for this result: the reply reset the pairing.
        readResult(4),
      ],
      droppedSummary: null,
    });
    expect(pagingHints(rendered).map((h) => h.next)).toEqual([
      "the line after the last one shown as `offset`",
      "the line after the last one shown as `offset`",
    ]);
  });
});

describe("packedConversationTurns", () => {
  it("caps each tool-result body exactly as the flat rendering does", () => {
    // Keep the bodies distinct so this test exercises per-result packing,
    // not the separate duplicate-body elision path.
    const secondBigFile = bigFile.replace("line 1 ", "item 1 ");
    const packed = {
      visibleTurns: [
        userTurn("review the game", 1),
        readCall({ path: "js/main.js" }, 2),
        readCall({ path: "js/ship.js", offset: 101, limit: 300 }, 3),
        readResult(4),
        readResult(5, secondBigFile),
        assistantReplyTurn("done", 6),
      ],
      droppedSummary: "summary: older turns",
    };
    const flat = renderPackedConversation(packed).split("\n");
    const turns = packedConversationTurns(packed);
    expect(turns.map((t) => t.kind)).toEqual([
      "user",
      "assistant_tool_call",
      "assistant_tool_call",
      "tool_result",
      "tool_result",
      "assistant_reply",
    ]);
    // Every structured body appears verbatim behind its flat header:
    // the same cap, the same paging hint, the same offset.
    const rendered = renderPackedConversation(packed);
    const structuredBodies = turns
      .filter((t): t is Extract<typeof t, { kind: "tool_result" }> => t.kind === "tool_result")
      .map((t) => t.body);
    expect(structuredBodies).toHaveLength(2);
    for (const body of structuredBodies) {
      expect(body.length).toBeLessThan(bigFile.length);
      expect(rendered).toContain(`tool_result[os.fs.read ok]: ${body}`);
    }
    expect(structuredBodies[0]).toContain("offset: ");
    expect(structuredBodies[1]).toContain("offset: ");
    expect(structuredBodies[0]).not.toBe(structuredBodies[1]);
    expect(flat[0]).toBe("summary: older turns");
  });

  it("carries a reply's attachment note the way the flat line does", () => {
    const turns = packedConversationTurns({
      visibleTurns: [
        assistantReplyTurn("here", { at: 1, attachments: ["/tmp/a.png"] }),
        toolResultTurn({ tool: "os.shell.run", status: "error", summary: "boom", truncated: true, at: 2 }),
      ],
      droppedSummary: null,
    });
    expect(turns).toEqual([
      { kind: "assistant_reply", text: "here (attached: /tmp/a.png)" },
      { kind: "tool_result", tool: "os.shell.run", status: "error", body: "boom", truncated: true },
    ]);
  });
});


describe("active read deduplication", () => {
  it("keeps one retained body per path, range and content in both wire forms", () => {
    const args = { path: "a.ts", offset: 1, limit: 2 };
    const turns = [
      userTurn("edit", 1), readCall(args, 2), readResult(3, "UNIQUE_BODY"),
      readCall(args, 4), readResult(5, "UNIQUE_BODY"),
      readCall({ ...args, path: "b.ts" }, 6), readResult(7, "UNIQUE_BODY"),
      readCall({ ...args, offset: 3 }, 8), readResult(9, "UNIQUE_BODY"),
      readCall(args, 10), readResult(11, "CHANGED_BODY"),
    ];
    const saved = JSON.stringify(turns);
    const packed = { visibleTurns: turns, droppedSummary: null };
    const bodies = packedConversationTurns(packed).filter((t) => t.kind === "tool_result");
    expect(bodies[0]!.body).toBe("UNIQUE_BODY");
    expect(bodies[1]!.body).not.toContain("UNIQUE_BODY");
    expect(bodies[2]!.body).toBe("UNIQUE_BODY");
    expect(bodies[3]!.body).toBe("UNIQUE_BODY");
    expect(bodies[4]!.body).toBe("CHANGED_BODY");
    expect(renderPackedConversation(packed)).toContain(bodies[1]!.body);
    expect(JSON.stringify(turns)).toBe(saved);
    const afterDrop = packedConversationTurns({ visibleTurns: turns.slice(3, 5), droppedSummary: "older" });
    expect(afterDrop[1]!.kind === "tool_result" && afterDrop[1]!.body).toBe("UNIQUE_BODY");
  });
});
