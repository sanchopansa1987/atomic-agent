import { describe, expect, it } from "vitest";
import { OpenAiProvider } from "./openai-provider.js";
import type { CompletionRequest } from "../completion-types.js";
import { buildCloudSubcallRequest } from "../cloud-subcall.js";

const tools = [{ type: "function", function: { name: "reply", parameters: { type: "object", properties: {} } } }];

describe("memory proxy request headers", () => {
  it.each([false, true])("isolates chats and auxiliary calls (stream=%s)", async (stream) => {
    const seen: Headers[] = [];
    const headers = { "X-Session-ID": "{{sessionId}}", "x-team-id": "team-test", "x-agent-id": "agent-test" };
    const provider = new OpenAiProvider({
      id: "memory", baseUrl: "http://localhost:8096/opencode/default/v1",
      apiKey: "test-key", defaultChatModel: "test", headers,
      fetchImpl: async (_url, init) => {
        seen.push(new Headers(init?.headers));
        return stream
          ? new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
          : Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      },
    });
    const send = async (request: CompletionRequest) => {
      if (!stream) return provider.complete(request);
      const gen = provider.completeStream(request);
      let next = await gen.next();
      while (!next.done) next = await gen.next();
      return next.value;
    };
    await Promise.all(["chat-a", "chat-b", "chat-a"].map(sessionId => send({ prompt: "hi", sessionId, tools, requestKind: "main" })));
    for (const sessionId of ["reflection:chat-a", "rewriter:chat-a", "vote:chat-a", undefined]) {
      await send(buildCloudSubcallRequest({
        prompt: "background", emitFunctionName: "emit_reflection",
        argsSchema: { type: "object", properties: {} },
        ...(sessionId ? { sessionId } : {}),
      }));
    }
    expect(seen.map(h => h.get("x-session-id"))).toEqual([
      "chat-a", "chat-b", "chat-a", "reflection:chat-a", "rewriter:chat-a", "vote:chat-a", null,
    ]);
    expect(seen.map(h => h.get("x-atomic-request-kind"))).toEqual([
      "main", "main", "main", "auxiliary", "auxiliary", "auxiliary", "auxiliary",
    ]);
    expect(seen.every(h => h.get("authorization") === "Bearer test-key" && h.get("x-team-id") === "team-test")).toBe(true);
    expect(headers["X-Session-ID"]).toBe("{{sessionId}}");
    await expect(send({ prompt: "hi", tools, requestKind: "main" })).rejects.toThrow("requires a session ID");
    await expect(send({ prompt: "hi", tools, sessionId: "bad\r\nid" })).rejects.toThrow("printable ASCII");
    expect(seen).toHaveLength(7);
  });

  it("preserves ordinary static headers and reports upstream authentication failures", async () => {
    const seen: Headers[] = [];
    const provider = new OpenAiProvider({
      id: "direct", baseUrl: "http://localhost:3001/v1", apiKey: "test", defaultChatModel: "test",
      headers: { "x-session-id": "legacy-static" },
      fetchImpl: async (_url, init) => {
        seen.push(new Headers(init?.headers));
        return new Response('{"error":{"message":"Invalid API key"}}', { status: 401 });
      },
    });
    await expect(provider.complete({ prompt: "hi", sessionId: "chat-a", tools })).rejects.toMatchObject({ status: 401 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.get("x-session-id")).toBe("legacy-static");
    expect(seen[0]?.has("x-atomic-request-kind")).toBe(false);
  });
});
