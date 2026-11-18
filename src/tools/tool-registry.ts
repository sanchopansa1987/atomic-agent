import {
  BLOB_OUTPUT_THRESHOLD_CHARS,
  RAW_TOOL_OUTPUT,
  type CompressedToolResult,
} from "../compressor/result-compressor.js";
import type { BlobStore } from "../session/blob-store.js";
import { coerceToolArgs } from "./coerce-tool-args.js";
import type { ToolRole } from "./tool-roles.js";

export interface ToolContext {
  /** Hard per-turn exclusions, including tool discovery. */
  toolFilter?: (name: string) => boolean;
  /** Working directory for OS tools and relative path resolution. */
  workingDir: string;
  sessionId: string;
  stepIndex: number;
  signal: AbortSignal;
  /**
   * The turn's tool role (`tool-roles.ts`), when the step knows it.
   * `tool.view` reads it to tell a tool that is already described in
   * full for this role (nothing to load) from one outside the role
   * (load it). Absent ⇒ `full`.
   */
  toolRole?: ToolRole;
  /**
   * Absolute paths the user named in this session's own messages
   * (`userNamedPaths`, `src/tools/read-scope/`), recomputed by the step
   * from the transcript. Under `agent.readScope: "working-dir"` a read
   * may go under any of these as well as under `workingDir`. Absent ⇒
   * nothing named.
   */
  readRoots?: readonly string[];
  /**
   * The step's full unfiltered tool descriptor list.  `tool.view`
   * consults this as a fallback when the static built-in map misses —
   * MCP tools are discovered at runtime and never enter
   * `TOOL_DESCRIPTOR_BY_NAME`, so without this fallback a tool that
   * the prompt advertises on its "also available via `tool.view`"
   * line is unreachable.
   */
  toolDescriptors?: readonly import("../prompt/stable-prefix.js").ToolDescriptor[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  readonly: boolean;
  run: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<CompressedToolResult>;
}

export class ToolNotFoundError extends Error {
  constructor(name: string) {
    super(`tool not registered: ${name}`);
    this.name = "ToolNotFoundError";
  }
}

/**
 * Tool registry: the agent loop calls `invoke()` and the registry takes
 * care of dispatch. Individual tools live in their own files and are
 * registered explicitly (no dynamic discovery).
 */
/**
 * Stable memo key. Arg order must not matter (the model emits the same call
 * with keys in any order), so the top level is sorted. A value that cannot be
 * stringified yields a unique key instead of a shared one — a miss costs one
 * call, a wrong hit costs correctness.
 */
function memoKey(
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
): string {
  try {
    return `${sessionId}:${name}:${JSON.stringify(args, Object.keys(args).sort())}`;
  } catch {
    return `${sessionId}:${name}:${Math.random()}`;
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  /**
   * Session-lifetime memo for read-only tool results. Measured 2026-10-31 over
   * 4,125 distinct calls across all traces: 446 signatures repeated, 1,098
   * redundant invocations (`skill.view ponytail` x83, `tool.view skill.view`
   * x30). Every repeat buys a model step plus its uncached tail (~614 of a
   * 4,044-token prompt), so serving the body already paid for is pure saving.
   *
   * Allow-list, not deny-list: a mutating tool must never be handed a stale
   * body, so anything not named here always runs. Any memo-breaking tool
   * clears the whole map — coarser than per-path invalidation and deliberately
   * so: a wrong cache hit is silent data loss, a cleared cache is only work.
   */
  private readonly memo = new Map<string, CompressedToolResult>();

  private static readonly MEMO_SAFE: ReadonlySet<string> = new Set([
    "os.fs.read",
    "os.fs.list",
    "os.fs.glob",
    "os.fs.grep",
    "os.fs.hash",
    "os.fs.locate_project",
    "skill.view",
    "tool.view",
    "tool.recall",
  ]);

  /** Tools that can change the world; a hit after one of these would be stale. */
  private static readonly MEMO_BREAKERS: ReadonlySet<string> = new Set([
    "os.fs.edit",
    "os.fs.write",
    "os.fs.patch",
    "os.fs.restore",
    "os.fs.trash",
    "os.shell.run",
  ]);

  constructor(private readonly blobStore?: BlobStore) {}

  register(definition: ToolDefinition): void {
    this.tools.set(definition.name, definition);
  }

  /**
   * Remove a tool by name. Returns `true` when a tool was actually
   * unregistered, `false` when the name was not known. Used by the
   * MCP manager to detach a server's tools cleanly on stop /
   * restart — the static native tools never call this.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolNotFoundError(name);
    return tool;
  }

  /**
   * Memo front door: a read-only tool called twice with the same args in one
   * session is served the body it already produced instead of being run again.
   * The reused body says so in `details.memo`, so neither the model nor a
   * later reader can mistake a hit for fresh work.
   */
  async invoke(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<CompressedToolResult> {
    if (ToolRegistry.MEMO_BREAKERS.has(name)) this.memo.clear();
    // Session-scoped: the memo used to key on tool+args alone, so a read
    // admitted (or answered at level 5) in one session was served to a
    // different session without ever reaching the read-scope check — the
    // cross-session leak read-scope-approval.test.ts caught.
    const key = ToolRegistry.MEMO_SAFE.has(name)
      ? memoKey(name, args, ctx.sessionId)
      : null;
    if (key) {
      const hit = this.memo.get(key);
      if (hit) return { ...hit, details: { ...hit.details, memo: "reused" } };
    }
    const result = await this.invokeFresh(name, args, ctx);
    // Only a successful, non-truncated body is worth serving again; a truncated
    // one carries a blob pointer that a later turn must re-read anyway.
    if (key && result.status === "ok" && !result.truncated) {
      this.memo.set(key, result);
    }
    return result;
  }

  private async invokeFresh(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<CompressedToolResult> {
    const tool = this.get(name);
    // Models sometimes emit a JSON value one level over-encoded (a
    // number as "200000", an array as "[\"a.png\"]"). Unwrap those
    // before dispatch; anything that cannot be coerced is passed
    // through untouched so the tool reports its own error.
    const returned = await tool.run(coerceToolArgs(name, args), ctx);
    const { [RAW_TOOL_OUTPUT]: rawOutput, ...result } = returned;
    if (!this.blobStore || ["reply", "finish", "tool.recall"].includes(name)) {
      return result;
    }
    const body = rawOutput ?? result.summary;
    // Store whenever ANYTHING was dropped, not only above 8 000 chars: a
    // truncated result whose middle was elided below that threshold used to be
    // unrecoverable — the marker said "N lines elided" and no blob existed.
    if (body.length <= BLOB_OUTPUT_THRESHOLD_CHARS && !result.truncated) return result;
    try {
      return { ...result, blob: await this.blobStore.put(body) };
    } catch {
      // A truncated body that could not be stored IS data loss: the reader would
      // see a marker with nothing behind it. Fail the call on the spot instead of
      // letting the turn continue on text nobody can read.
      if (result.truncated) {
        throw new Error(
          `truncated output from ${name} could not be stored — refusing to continue on unseen output`,
        );
      }
      // The tool already ran: a storage failure must not turn it into a
      // failed action that the agent may repeat, or advertise a missing blob.
      return {
        ...result,
        details: { ...result.details, blobStoreError: "Full output could not be saved." },
      };
    }
  }
}
