import { describe, it, expect } from "vitest";
import {
  assistantReplyTurn,
  assistantToolCallTurn,
  packConversation,
  toolResultTurn,
  userTurn,
  type ConversationTurn,
} from "./conversation-turn.js";
import { packedConversationTurns } from "../prompt/build-prompt-world-conversation.js";
import { buildNativeMessages } from "../llm/provider/openai/openai-native-messages.js";
import { estimateTokens } from "../prompt/token-budget.js";

/**
 * Regression for the prompting defect: `packConversation` sized the
 * transcript with `renderTurnForPrompt`, which never prints the
 * assistant's `reasoning`, while the native projection echoes that
 * reasoning back (`buildNativeMessages` under `reasoningField` — DeepSeek
 * V4 thinking mode rejects the next request without it). The budget said
 * the history fit; the payload the provider received carried the whole
 * retained reasoning on top.
 *
 * These tests measure the payload that would actually be sent — the
 * native history messages, reasoning included — and require the packer to
 * hold it under the cap.
 */
const nameEscape = (qualified: string): string => qualified.replace(/\./g, "__");

/** Structure the native message adds around its content (role, ids, keys). */
const NATIVE_MESSAGE_OVERHEAD_TOKENS = 12;

function nativeHistoryTokens(messages: readonly Record<string, unknown>[]): number {
  // The first message is the `system` prefix and the last is the `tail`
  // user message — both live outside the conversation cap, so only the
  // history between them is charged here.
  const history = messages.slice(1, -1);
  let tokens = 0;
  for (const message of history) {
    tokens += NATIVE_MESSAGE_OVERHEAD_TOKENS;
    if (typeof message.content === "string") {
      tokens += estimateTokens(message.content);
    }
    if (typeof message.reasoning_content === "string") {
      tokens += estimateTokens(message.reasoning_content);
    }
    const toolCalls = message.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const fn = (call as { function: { name: string; arguments: string } })
          .function;
        tokens += estimateTokens(fn.name) + estimateTokens(fn.arguments);
      }
    }
  }
  return tokens;
}

function nativePayloadTokens(packed: ReturnType<typeof packConversation>): number {
  const messages = buildNativeMessages(
    {
      system: "system",
      droppedSummary: packed.droppedSummary,
      turns: packedConversationTurns(packed),
      tail: "tail",
    },
    { nameEscape, reasoningField: "reasoning_content" },
  );
  return nativeHistoryTokens(messages);
}

/** One macro-turn whose assistant reasoning dwarfs its visible text. */
function reasoningMacroTurn(index: number): ConversationTurn[] {
  return [
    userTurn(`task number ${index}`, index * 10),
    assistantToolCallTurn({
      tool: "os.fs.read",
      args: { path: `/tmp/file-${index}.ts` },
      reasoning: `deliberation ${index} `.repeat(200),
      at: index * 10 + 1,
    }),
    toolResultTurn({
      tool: "os.fs.read",
      status: "ok",
      summary: `contents of file ${index}`,
      at: index * 10 + 2,
    }),
    assistantReplyTurn(`done with task ${index}`, index * 10 + 3),
  ];
}

describe("conversation pack budgets retained reasoning", () => {
  const BUDGET = 8_000;

  it("holds the native history — reasoning included — under the cap", () => {
    const turns = Array.from({ length: 12 }, (_, i) => reasoningMacroTurn(i)).flat();
    const packed = packConversation(turns, BUDGET);
    const nativeTokens = nativePayloadTokens(packed);
    // Before the fix the packer saw only the one-line text render, kept
    // every macro-turn, and this figure ran ~3x the cap.
    expect(nativeTokens).toBeLessThanOrEqual(Math.ceil(BUDGET * 1.1));
    expect(packed.droppedCount).toBeGreaterThan(0);
  });

  it("keeps the current user task even when reasoning forces a deep cut", () => {
    const turns = Array.from({ length: 12 }, (_, i) => reasoningMacroTurn(i)).flat();
    const packed = packConversation(turns, BUDGET);
    const lastUser = [...packed.visibleTurns]
      .reverse()
      .find((turn) => turn.kind === "user");
    expect(lastUser).toEqual(userTurn("task number 11", 110));
  });

  it("does not change pricing for turns that carry no reasoning", () => {
    const withoutReasoning = [userTurn("hi", 1), assistantReplyTurn("hello", 2)];
    const packed = packConversation(withoutReasoning, BUDGET);
    expect(packed.droppedCount).toBe(0);
    expect(packed.visibleTurns).toEqual(withoutReasoning);
  });
});
