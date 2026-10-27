import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";
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
  source: "tdai" | "local-fallback";
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

function stateDir(): string {
  return process.env.ATOMIC_AGENT_STATE_DIR ?? join(homedir(), ".atomic-agent");
}

/** FTS5-safe query: lower-case, tokenise, quote each term, OR-join. */
function ftsQuery(text: string): string {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

/**
 * Read-only local FTS fallback, matching `scripts/atomic_memory.py`
 * `local_search`: the local index the vault is synced into. Tagged
 * `local-fallback` so a degraded read is never mistaken for "no memories".
 */
function localSearch(text: string, limit: number): MemoryHit[] {
  const dbPath = join(stateDir(), "memory.sqlite");
  const query = ftsQuery(text);
  if (!query || !existsSync(dbPath)) return [];
  let db: Database.Database | null = null;
  try {
    db = new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        "SELECT rowid, content FROM memories_fts WHERE memories_fts MATCH ? LIMIT ?",
      )
      .all(query, limit) as Array<{ rowid: number; content: string }>;
    return rows.map((row) => ({
      id: String(row.rowid),
      source: "local-fallback" as const,
      content: String(row.content ?? ""),
      score: 0,
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/**
 * Query the gateway's conversation search. On any failure — missing key,
 * dead identity probe, transport error, malformed response — it falls
 * through to the local FTS index and returns `local-fallback` rows, so a
 * dead gateway never reads as "no memories". A live gateway returning an
 * empty `messages` list is a genuine negative and stays an empty array.
 */
export async function searchMemory(
  query: string,
  options?: SearchMemoryOptions,
): Promise<MemoryHit[]> {
  const cfg = getTdaiGatewayConfig();
  const topK = options?.topK ?? cfg.topK;
  const timeoutMs = options?.timeoutMs ?? cfg.timeoutMs;
  try {
    const apiKey = process.env.TDAI_GATEWAY_API_KEY;
    if (!apiKey) throw new Error("missing TDAI_GATEWAY_API_KEY");

    const identity = await getAgentIdentity();
    if (!identity) throw new Error("gateway identity unavailable");

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
    if (!body) throw new Error("gateway returned no search results");
    if (body.code !== 0) throw new Error(`gateway returned code ${String(body.code)}`);
    const messages = (body.data as { messages?: unknown[] } | undefined)?.messages;
    if (!Array.isArray(messages)) {
      throw new Error("gateway returned no search results");
    }

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
  } catch (err) {
    process.stderr.write(
      `[tdai] gateway unavailable (${err instanceof Error ? err.message : String(err)}); using the local index\n`,
    );
    return localSearch(query, topK);
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
