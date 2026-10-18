import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ToolCallPayload } from "../llm/grammar/tool-call-grammar.js";
import type { ConversationTurn } from "../session/conversation-turn.js";

const MARKER = "## DSH memory rules (DeepSeek only)";
const SOURCE = /\.(?:py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|c|cpp|h|rb|sh)(?:$|[},])/i;

function projectRoot(workingDir: string): string | undefined {
  for (let dir = resolve(workingDir); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "scripts/atomic_memory.py"))) {
      try {
        if (readFileSync(join(dir, "AGENTS.md"), "utf8").includes(MARKER)) return dir;
      } catch { /* No opt-in at this level. */ }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

// Recognize only simple command forms, never shell chains/substitutions.
function words(call: ToolCallPayload): string[] {
  if (call.tool !== "os.shell.run" || typeof call.args.cmd !== "string") return [];
  const args = call.args.args;
  if (Array.isArray(args) && args.length) {
    return args.every(a => typeof a === "string") && !/\s/.test(call.args.cmd)
      ? [call.args.cmd, ...args as string[]] : [];
  }
  if (/[;&|<>$`\\]/.test(call.args.cmd)) return [];
  const tokens = call.args.cmd.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
  return tokens.map(t => /^(".*"|'.*')$/.test(t) ? t.slice(1, -1) : t);
}

function prerequisite(call: ToolCallPayload, root: string, workingDir: string): string | null {
  if (call.tool === "skill.view" && call.args.name === "ponytail") return "ponytail";
  const argv = words(call);
  if (argv.length !== 4) return null;
  if (basename(argv[0]!) === "graft" && argv[1] === "ask" && argv[2]?.trim() && argv[3] === "--source") return "graft";
  const cwd = typeof call.args.cwd === "string" ? resolve(workingDir, call.args.cwd) : workingDir;
  if (/^python(?:3(?:\.\d+)?)?$/.test(basename(argv[0]!)) &&
      resolve(cwd, argv[1]!) === join(root, "scripts/atomic_memory.py")) {
    if (argv[2] === "search" && argv[3]?.trim()) return "memory";
    if (argv[2] === "sync" && resolve(cwd, argv[3]!) === join(root, "vault/agent-memory/MEMORY_WORKFLOW_2026-10-01.md")) return "sync";
  }
  return null;
}

/** A snapshot: calls from this batch cannot satisfy another call in this batch. */
export function projectWorkflowGuard(
  workingDir: string,
  turns: readonly ConversationTurn[],
): ((call: ToolCallPayload) => string | null) | undefined {
  const root = projectRoot(workingDir);
  if (!root) return undefined;
  const completed = new Set<string>();
  const pending = new Map<string, ToolCallPayload[]>();
  for (const turn of turns) {
    if (turn.kind === "user") {
      completed.clear();
      pending.clear();
    } else if (turn.kind === "assistant_tool_call") {
      const queue = pending.get(turn.tool) ?? [];
      queue.push({ tool: turn.tool, args: turn.args });
      pending.set(turn.tool, queue);
    } else if (turn.kind === "tool_result") {
      const call = pending.get(turn.tool)?.shift();
      if (!call) continue;
      const kind = prerequisite(call, root, workingDir);
      // skill.view is idempotent: viewing an already-loaded skill answers with a
      // no-op/duplicate result, never `ok`. Requiring `ok` here deadlocked every
      // later turn — the guard demanded an event the tool could no longer produce,
      // so shell and source edits stayed refused forever. Asking for the skill at
      // all is proof it was read; re-reading it is not a second requirement.
      if (kind === "ponytail") { completed.add(kind); continue; }
      if (turn.status !== "ok") continue;
      if (call.tool === "os.shell.run" && !/\bexit:\s*0\b/.test(turn.summary)) continue;
      if (kind && kind !== "sync") completed.add(kind);
    }
  }
  return call => {
    if (prerequisite(call, root, workingDir)) return null;
    const sourcePath = [call.args.path, call.args.pattern, call.args.glob]
      .flatMap(value => Array.isArray(value) ? value : [value])
      .some(value => typeof value === "string" && SOURCE.test(value));
    const shell = call.tool === "os.shell.run";
    const mutation = ["os.fs.write", "os.fs.edit", "os.fs.patch"].includes(call.tool) && sourcePath;
    const lookup = call.tool === "os.fs.grep" ||
      (["os.fs.read", "os.fs.glob"].includes(call.tool) && sourcePath);
    if (!shell && !mutation && !lookup) return null;
    const required = shell || mutation ? ["memory", "graft", "ponytail"] : ["memory", "graft"];
    const missing = required.filter(kind => !completed.has(kind));
    if (!missing.length) return null;
    const instructions: Record<string, string> = {
      memory: 'run .venv-dev/bin/python scripts/atomic_memory.py search "<topic>" from the project root',
      graft: 'run graft ask "<target symbol>" --source',
      ponytail: 'call skill.view({name:"ponytail"})',
    };
    return `Project workflow: before this call, ${missing.map(k => instructions[k]).join("; ")}. Complete prerequisites in earlier steps of this user turn. Keep normal approvals; report unavailable services instead of reading credentials.`;
  };
}
