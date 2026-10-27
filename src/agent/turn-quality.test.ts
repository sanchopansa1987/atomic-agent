import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationTurn } from "../session/conversation-turn.js";
import {
  appendTurnQualityRow,
  computeTurnQuality,
} from "./turn-quality.js";

const turns: ConversationTurn[] = [
  { kind: "user", text: "fix it", at: 1 },
  { kind: "assistant_tool_call", tool: "os.fs.edit", args: { path: "/a.js" }, at: 2 },
  { kind: "tool_result", tool: "os.fs.edit", status: "ok", summary: "", at: 3 },
  { kind: "assistant_tool_call", tool: "os.fs.edit", args: { path: "/a.js" }, at: 4 },
  { kind: "tool_result", tool: "os.fs.edit", status: "ok", summary: "", at: 5 },
  { kind: "assistant_tool_call", tool: "os.shell.run", args: { cmd: "x" }, at: 6 },
  { kind: "tool_result", tool: "os.shell.run", status: "error", summary: "", at: 7 },
  {
    kind: "assistant_reply",
    text: "done",
    unverifiedClaims: ["tests pass", "node --check"],
    at: 8,
  },
];

describe("computeTurnQuality", () => {
  it("derives the four fields from a turn fixture", () => {
    const q = computeTurnQuality(turns, 4);
    expect(q).toEqual({
      steps_used: 4,
      tools_failed: 1,     // the one shell error
      claims_refused: 2,   // two unverified claim texts
      rework: 1,           // /a.js edited twice
    });
  });
});

describe("appendTurnQualityRow", () => {
  it("appends exactly one JSONL row with the four fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-quality-"));
    try {
      const path = join(dir, "results", "turn-quality.jsonl");
      appendTurnQualityRow(path, {
        steps_used: 4,
        tools_failed: 1,
        claims_refused: 2,
        rework: 1,
      });
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const row = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(Object.keys(row).sort()).toEqual([
        "claims_refused",
        "rework",
        "steps_used",
        "tools_failed",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
