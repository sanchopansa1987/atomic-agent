import type { CompletionRequest } from "../completion-types.js";
import type { OpenAiHttpDeps } from "./openai-http.js";

/** Opt in with x-session-id: {{sessionId}} on the local memory provider. */
export function resolveMemoryProxyHttp(
  http: OpenAiHttpDeps,
  request?: Pick<CompletionRequest, "sessionId" | "requestKind">,
): OpenAiHttpDeps {
  const entries = Object.entries(http.extraHeaders);
  if (!entries.some(([name, value]) =>
    name.toLowerCase() === "x-session-id" && value === "{{sessionId}}",
  )) return http;

  const headers = Object.fromEntries(entries.map(([name, value]) => [name.toLowerCase(), value]));
  if (headers["x-conversation-id"]) {
    throw new Error("Memory proxy: x-conversation-id would override the chat session ID");
  }
  // Reflection can carry synthetic tools too. Only the main step's explicit
  // marker enables conversation memory; unknown callers fail closed to auxiliary.
  const main = request?.requestKind === "main";
  const sessionId = request?.sessionId;
  if (main && !sessionId) throw new Error("Memory proxy: main request requires a session ID");
  if (sessionId !== undefined && !/^[\x21-\x7e]+$/.test(sessionId)) {
    throw new Error("Memory proxy: session ID must be nonempty printable ASCII without spaces");
  }
  if (sessionId) headers["x-session-id"] = sessionId;
  else delete headers["x-session-id"];
  headers["x-atomic-request-kind"] = main ? "main" : "auxiliary";
  return { ...http, extraHeaders: headers };
}
