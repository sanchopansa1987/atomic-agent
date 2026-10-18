import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  PromptMessages,
  PromptTurn,
} from "../llm/provider/completion-types.js";

/**
 * Thin, never-throwing client for the TencentDB memory gateway
 * (127.0.0.1:8420). Additive to the internal memory fabric: it only
 * reads memory, never writes, and is gated by `memory.tdaiGateway.enabled`
 * (checked by the caller).
 *
 * The gateway config is read straight from the user config file rather
 * than the resolved runtime config, so this module stays self-contained
 * and does not depend on `load-config.ts` carrying the new block.
 */

export interface MemoryHit {
  id: string;
  source: "tdai";
  content: string;
  score: number;
  ts?: string;
}

export interface AgentIdentity {
  user_id: string;
  agent_id: string;
  team_id: string;
}

export interface SearchMemoryOptions {
  topK?: number;
  timeoutMs?: number;
}

export interface TdaiGatewayConfig {
  enabled: boolean;
  baseUrl: string;
  serviceId: string;
  topK: number;
  timeoutMs: number;
}

const DEFAULTS: TdaiGatewayConfig = {
  enabled: false,
  baseUrl: "http://127.0.0.1:8420",
  serviceId: "atomic-live",
  topK: 5,
  timeoutMs: 3000,
};

function configPath(): string {
  return join(homedir(), ".atomic-agent", "config.json");
}

function readRawConfig(): Record<string, unknown> {
  try {
    return JSON.parse(
      readFileSync(configPath(), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Resolve the effective gateway config (config file + defaults). */
export function getTdaiGatewayConfig(): TdaiGatewayConfig {
  const raw = readRawConfig();
  const mem = (raw.memory ?? {}) as Record<string, unknown>;
  const t = (mem.tdaiGateway ?? {}) as Record<string, unknown>;
  return {
    enabled: t.enabled === true,
    baseUrl: typeof t.baseUrl === "string" ? t.baseUrl : DEFAULTS.baseUrl,
    serviceId:
      typeof t.serviceId === "string" ? t.serviceId : DEFAULTS.serviceId,
    topK: typeof t.topK === "number" ? t.topK : DEFAULTS.topK,
    timeoutMs:
      typeof t.timeoutMs === "number" ? t.timeoutMs : DEFAULTS.timeoutMs,
  };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the caller's user_id from the gateway using the configured identity. */
export async function getAgentIdentity(): Promise<AgentIdentity | null> {
  try {
    const cfg = getTdaiGatewayConfig();
    const apiKey = process.env.TDAI_GATEWAY_API_KEY;
    const adminKey = process.env.TDAI_ADMIN_KEY;
    if (!apiKey || !adminKey) return null;

    const raw = readRawConfig();
    const llm = (raw.llm ?? {}) as {
      providers?: Array<{ id?: string; headers?: Record<string, string> }>;
    };
    const provider = (llm.providers ?? []).find((p) => p.id === "freellmapi");
    const headers = provider?.headers ?? {};
    const agentId = headers["x-agent-id"];
    const teamId = headers["x-team-id"];
    if (!agentId || !teamId) return null;

    const body = await postJson(
      `${cfg.baseUrl}/v3/meta/agent/get`,
      { agent_id: agentId },
      {
        Authorization: `Bearer ${apiKey}`,
        "x-tdai-service-id": cfg.serviceId,
        "x-tdai-user-key": adminKey,
      },
      cfg.timeoutMs,
    );
    const data = body?.data as
      | { owner_user_id?: string; agent_id?: string; team_id?: string }
      | undefined;
    if (!body || body.code !== 0 || !data?.owner_user_id) return null;
    if (data.agent_id !== undefined && data.agent_id !== agentId) return null;
    if (data.team_id !== undefined && data.team_id !== teamId) return null;
    return { user_id: data.owner_user_id, agent_id: agentId, team_id: teamId };
  } catch {
    return null;
  }
}

/** Query the gateway's conversation search. Never throws; returns [] on any failure. */
export async function searchMemory(
  query: string,
  options?: SearchMemoryOptions,
): Promise<MemoryHit[]> {
  try {
    const cfg = getTdaiGatewayConfig();
    const apiKey = process.env.TDAI_GATEWAY_API_KEY;
    if (!apiKey) return [];

    const identity = await getAgentIdentity();
    if (!identity) return [];

    const topK = options?.topK ?? cfg.topK;
    const timeoutMs = options?.timeoutMs ?? cfg.timeoutMs;

    const body = await postJson(
      `${cfg.baseUrl}/v3/conversation/search`,
      {
        user_id: identity.user_id,
        agent_id: identity.agent_id,
        team_id: identity.team_id,
        query,
        limit: topK,
      },
      {
        Authorization: `Bearer ${apiKey}`,
        "x-tdai-service-id": cfg.serviceId,
      },
      timeoutMs,
    );
    const messages = (body?.data as { messages?: unknown[] } | undefined)?.messages;
    if (!body || body.code !== 0 || !Array.isArray(messages)) return [];

    return messages
      .map((m) => {
        const row = (m ?? {}) as Record<string, unknown>;
        return {
          id: String(row.id ?? ""),
          source: "tdai" as const,
          content: String(row.content ?? ""),
          score: typeof row.score === "number" ? row.score : 0,
          ...(row.ts !== undefined ? { ts: String(row.ts) } : {}),
        };
      })
      .filter((h) => h.content.length > 0);
  } catch {
    return [];
  }
}

/** Render hits as a stable `### relevant memory` section. */
export function formatForPrompt(hits: MemoryHit[]): string {
  const lines = hits
    .map((h) => h.content.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  return `### relevant memory\n${lines.join("\n")}`;
}

/** Trim a raw user message into a short search query (cap 200, strip fences/URLs). */
export function extractQuery(raw: string | null | undefined): string {
  if (!raw) return "";
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

/** Insert `section` into the flat prompt immediately before `### conversation`. */
export function injectSectionBeforeConversation(
  text: string,
  section: string,
): string {
  if (!section) return text;
  const marker = "### conversation";
  const idx = text.indexOf(marker);
  if (idx === -1) return `${section}\n\n${text}`;
  return `${text.slice(0, idx)}${section}\n\n${text.slice(idx)}`;
}

/** Prepend `section` to the last `user` turn's text (never a synthetic system message). */
export function prependSectionToLastUserTurn(
  messages: PromptMessages,
  section: string,
): PromptMessages {
  if (!section) return messages;
  const turns = [...messages.turns] as PromptTurn[];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn && turn.kind === "user") {
      turns[i] = { kind: "user", text: `${section}\n\n${turn.text}` };
      break;
    }
  }
  return { ...messages, turns };
}
