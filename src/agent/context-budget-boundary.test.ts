import { describe, it, expect } from "vitest";
import {
  ContextBudgetExceededError,
  executeStep,
} from "./step-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import {
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "../session/conversation-turn.js";
import type { CapabilitiesSummary } from "../prompt/stable-prefix.js";
import { openAiToolCallAdapter } from "../llm/provider/openai/openai-tool-call-adapter.js";
import { AgentLoop } from "./agent-loop.js";

/**
 * The native request budget boundary, end to end. With the default config
 * (`agent.conversationMaxTokens: 0`, no probed context window) the
 * effective conversation cap is the 32k fallback. One active user task
 * whose retained reasoning alone clears 32k tokens cannot be packed under
 * it, because the packer pins the task's user turn and its complete tool
 * exchanges. The step must therefore open **zero** provider submissions:
 * `executeStep` raises `ContextBudgetExceededError` before `llmComplete`
 * is ever called.
 */
const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

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

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "os.fs.read",
    description: "read",
    readonly: true,
    async run() {
      return compressToolResult({
        tool: "os.fs.read",
        status: "ok",
        output: "body",
      });
    },
  });
  registry.register({
    name: "reply",
    description: "reply",
    readonly: true,
    async run(args: Record<string, unknown>) {
      return compressToolResult({
        tool: "reply",
        status: "ok",
        output: String(args.text ?? ""),
      });
    },
  });
  return registry;
}

describe("native request budget boundary", () => {
  it("hard-excludes non-surfaced schemas from the wire", async () => {
    const seen: string[][] = [];
    for (const loaded of [false, true]) {
      const session = {
        ...createEmptySessionState({ id: "s-surface", workingDir: "/w" }),
        turns: [userTurn("say hi", 1)],
        loadedTools: loaded ? [{ name: "os.fs.read", summary: "Read", argsSchema: '{"path":string}' }] : [],
      };
      await expect(executeStep({
        session, toolDescriptors: DEFAULT_TOOL_DESCRIPTORS, capabilities: CAPS,
        skillCatalog: [], stepIndex: 0, signal: new AbortController().signal,
        userMessage: "say hi", toolFilter: (name) => name === "reply" || name === "tool.view",
      }, {
        registry: makeRegistry(), slotManager: new SlotManager(2),
        llmComplete: async (params) => {
          seen.push((params.tools ?? []).map((t) => (t.function as {name:string}).name));
          throw new Error("captured schemas");
        },
        grammar: "", profile: PLAIN_INSTRUCT_PROFILE, toolTransport: "native_tools",
        toolCallAdapter: null, supportsSlotAffinity: false,
      })).rejects.toThrow("captured schemas");
    }
    expect(seen[0]).toEqual(expect.arrayContaining(["reply", "finish", "tool__view"]));
    expect(seen[0]).toHaveLength(3);
    // `toolFilter` is a hard exclusion: it also drops a loaded tool.
    expect(seen[1]).toEqual(expect.arrayContaining(["reply", "finish", "tool__view"]));
    expect(seen[1]).toHaveLength(3);
  });

  it.each(["schema", "stream", "static"])("blocks oversized full requests before a provider call (%s)", async (kind) => {
    const stream = kind === "stream";
    let submissions = 0;
    const session = {
      ...createEmptySessionState({ id: "s-schema", workingDir: "/w" }),
      turns: [userTurn("say hi", 1)],
    };
    const submit = async () => { submissions += 1; throw new Error("must not submit"); };
    const request = executeStep({
      session, toolDescriptors: kind === "static"
        ? [{ ...DEFAULT_TOOL_DESCRIPTORS[0]!, summary: "static instruction ".repeat(20000) }]
        : DEFAULT_TOOL_DESCRIPTORS, capabilities: CAPS,
      skillCatalog: [], stepIndex: 0, signal: new AbortController().signal,
      userMessage: "say hi",
    }, {
      registry: makeRegistry(), slotManager: new SlotManager(2),
      llmComplete: submit,
      ...(stream ? { llmCompleteStream: () => { submissions += 1; throw new Error("must not stream"); } } : {}),
      grammar: "", profile: PLAIN_INSTRUCT_PROFILE, toolTransport: "native_tools",
      toolCallAdapter: { ...openAiToolCallAdapter, descriptorsToTools: () => [{
        type: "function", function: { name: "reply", parameters: {
          type: "object", description: kind === "static" ? "small schema" : "schema detail ".repeat(20000),
        } },
      }] }, supportsSlotAffinity: false,
    });
    await expect(request).rejects.toThrow(/full request needs/);
    expect(submissions).toBe(0);
  });

  it("preserves an actionable continuation without an auto-continue request loop", async () => {
    let submissions = 0;
    const session = {
      ...createEmptySessionState({ id: "s-persist", workingDir: "/w" }),
      turns: oneActiveTask(),
    };
    const before = JSON.stringify(session.turns);
    const agent = new AgentLoop({
      registry: makeRegistry(), slotManager: new SlotManager(2),
      llmComplete: async () => { submissions += 1; throw new Error("must not submit"); },
      grammar: "", profile: PLAIN_INSTRUCT_PROFILE, toolTransport: "native_tools",
      toolCallAdapter: null, supportsSlotAffinity: false,
      toolDescriptors: DEFAULT_TOOL_DESCRIPTORS, capabilities: CAPS, skillCatalog: [],
    });
    const result = await agent.runTurn(session, {
      userMessage: "Finish the analysis without rereading everything", autoContinue: true,
      maxSteps: 5, taskMaxSteps: 20, signal: new AbortController().signal,
    });
    expect(submissions).toBe(0);
    expect(result.stopCause).toBe("context_budget");
    expect(JSON.stringify(session.turns)).toBe(before);
    const saved = JSON.parse(JSON.stringify(result.session));
    expect(saved.metadata.continuationHandoff).toContain("Goal (reference data");
    expect(saved.metadata.continuationHandoff).toContain("s-persist");
    expect(saved.metadata.continuationHandoff).toContain("/tmp/step-");
    expect(saved.metadata.continuationHandoff.length).toBeLessThan(5000);
    expect(saved.metadata.continuationHandoffAt).toBeGreaterThan(0);
  });

  it("opens zero provider submissions when protected context cannot fit", async () => {
    const session = {
      ...createEmptySessionState({ id: "s-budget", workingDir: "/w" }),
      turns: oneActiveTask(),
    };
    let submissions = 0;

    let thrown: unknown = null;
    try {
      await executeStep(
        {
          session,
          toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
          capabilities: CAPS,
          skillCatalog: [],
          stepIndex: 0,
          signal: new AbortController().signal,
          userMessage: "run the long analysis",
        },
        {
          registry: makeRegistry(),
          slotManager: new SlotManager(2),
          llmComplete: async () => {
            submissions += 1;
            throw new Error("provider must not be called on an over-budget task");
          },
          grammar: "",
          profile: PLAIN_INSTRUCT_PROFILE,
          toolTransport: "native_tools",
          toolCallAdapter: null,
          supportsSlotAffinity: false,
        },
      );
    } catch (err) {
      thrown = err;
    }

    expect(submissions).toBe(0);
    expect(thrown).toBeInstanceOf(ContextBudgetExceededError);
    const error = thrown as ContextBudgetExceededError;
    expect(error.overBudget.requiredTokens).toBeGreaterThan(error.overBudget.budget);
    expect(error.handoff).toContain("continuation-handoff");
  });

  it("lets a short active task reach the provider", async () => {
    const session = {
      ...createEmptySessionState({ id: "s-ok", workingDir: "/w" }),
      turns: [userTurn("say hi", 1)],
    };
    let submissions = 0;

    const outcome = await executeStep(
      {
        session,
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: [],
        stepIndex: 0,
        signal: new AbortController().signal,
        userMessage: "say hi",
      },
      {
        registry: makeRegistry(),
        slotManager: new SlotManager(2),
        llmComplete: async () => {
          submissions += 1;
          return {
            content: JSON.stringify([{ tool: "reply", args: { text: "hi" } }]),
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: {
              promptMs: 1,
              predictedMs: 1,
              promptTokens: 20,
              predictedTokens: 5,
            },
            cacheHitTokens: 0,
            slotId: -1,
            modelId: "mock",
          };
        },
        grammar: "",
        profile: PLAIN_INSTRUCT_PROFILE,
        toolTransport: "native_tools",
        toolCallAdapter: null,
        supportsSlotAffinity: false,
      },
    );

    expect(submissions).toBe(1);
    expect(outcome.terminal).toBe("turn");
  });
});
