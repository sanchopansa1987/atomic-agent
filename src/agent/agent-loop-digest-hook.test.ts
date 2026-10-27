import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "./agent-loop.js";
import type { DigestHook, DigestWorkItem } from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

/**
 * Queue #9 — digest hook integration with `AgentLoop.runTurn`.
 * Mirrors `agent-loop-lesson-lifecycle.test.ts`: the hook fires once at the
 * turn-end seam, with the distilled work-item args (title = request, body =
 * final reply, tags = []). Fire-safe and absent when no digest hook is wired.
 */

function makeCompletion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

const TOOLS: ToolDescriptor[] = [
  {
    name: "finish",
    summary: "Finish the session with a summary.",
    argsSchema: '{"summary": string}',
  },
];

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

const SKILLS: SkillCatalogEntry[] = [];

function captureDigest(items: DigestWorkItem[]): DigestHook {
  return {
    recordWorkItem(item) {
      items.push(item);
    },
  };
}

describe("AgentLoop digest hook (queue #9)", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-digest-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it("fires once at turn end with the distilled work-item args", async () => {
    const items: DigestWorkItem[] = [];
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(
          JSON.stringify({
            tool: "reply",
            args: { text: "landed the fix; tests pass" },
          }),
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      digest: captureDigest(items),
    });
    const session = createEmptySessionState({ id: "s-digest", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "fix the bug",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      sessionId: "s-digest",
      title: "fix the bug",
      body: "landed the fix; tests pass",
      tags: [],
    });
  });

  it("does not fire when no digest hook is wired", async () => {
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () =>
        makeCompletion(
          JSON.stringify({ tool: "reply", args: { text: "done" } }),
        ),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const session = createEmptySessionState({ id: "s-no-digest", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "x",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("reply");
  });

  it("does not fire on a failed turn", async () => {
    const items: DigestWorkItem[] = [];
    const loop = new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete: async () => {
        throw new Error("boom — mock LLM rejected");
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      digest: captureDigest(items),
    });
    const session = createEmptySessionState({ id: "s-failed", workingDir });
    const result = await loop.runTurn(session, {
      userMessage: "x",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("failed");
    expect(items).toEqual([]);
  });
});
