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

const SHELL = /^(?:ba|z|da)?sh$/i;
const META = /[;&|<>$`\\]/;

function tokens(command: string): string[] {
  const found = command.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
  return found.map(t => /^(".*"|'.*')$/.test(t) ? t.slice(1, -1) : t);
}

// Flatten a shell call into one token stream: the command, its argv, and — for
// `bash -lc "<script>"` — the script's own tokens. Composite scripts (`a; b`,
// `cd x && y`, `for … done`) flatten too: prerequisite() scans for markers
// anywhere in the stream now, so the wrapper no longer hides them.
function commandTokens(call: ToolCallPayload): string[] {
  if (call.tool !== "os.shell.run" || typeof call.args.cmd !== "string") return [];
  const args = call.args.args;
  if (!Array.isArray(args) || args.length === 0) return tokens(call.args.cmd);
  const head = call.args.cmd;
  if (SHELL.test(basename(head)) && /^-[A-Za-z]*c[A-Za-z]*$/.test(String(args[0])) &&
      typeof args[1] === "string") {
    return [head, String(args[0]), ...tokens(args[1])];
  }
  return [head, ...args.map(String)];
}

function prerequisite(call: ToolCallPayload, root: string, workingDir: string): string | null {
  if (call.tool === "skill.view" && call.args.name === "ponytail") return "ponytail";
  const argv = commandTokens(call);
  if (!argv.length) return null;
  // A stack self-audit run satisfies its own prerequisite: the gate must never
  // demand a check it also blocks (that is a deadlock, not a rule).
  if (argv.some(w => w.includes("ensure-stack.sh"))) return "stack";

  // Scan the whole argv rather than only a lone simple command. Agents batch
  // their prerequisites into `bash -lc '<cd … && cmd>'`, `for … done` loops and
  // `a; b` chains; the old exact-form match was blind to every one of them, so
  // the same turn both performed the prerequisite and was refused for not
  // having performed it — 330 such refusals across the recorded runs. Proof of
  // run is not a security boundary, so a mention inside a composite command
  // counts.
  let cwd = typeof call.args.cwd === "string" ? resolve(workingDir, call.args.cwd) : workingDir;
  const memScript = join(root, "scripts/atomic_memory.py");
  const syncScript = join(root, "vault/agent-memory/MEMORY_WORKFLOW_2026-10-01.md");
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    const base = basename(word);
    if (word === "cd" && typeof argv[i + 1] === "string" && !META.test(argv[i + 1]!)) {
      cwd = resolve(cwd, argv[i + 1]!);
      continue;
    }
    if (base === "graft" && argv[i + 1] === "ask" &&
        argv[i + 2]?.trim().length && argv[i + 3] === "--source") return "graft";
    if (!/^python(?:3(?:\.\d+)?)?$/.test(base) || typeof argv[i + 1] !== "string") continue;
    const script = resolve(cwd, argv[i + 1]!);
    if (script !== memScript) continue;
    if (argv[i + 2] === "search" && argv[i + 3]?.trim().length) return "memory";
    if (argv[i + 2] === "sync" && resolve(cwd, argv[i + 3] ?? "") === syncScript) return "sync";
  }
  return null;
}

/** A snapshot: calls from this batch cannot satisfy another call in this batch. */
export function projectWorkflowGuard(
  workingDir: string,
  turns: readonly ConversationTurn[],
  loadedSkills: readonly string[] = [],
): ((call: ToolCallPayload) => string | null) | undefined {
  const root = projectRoot(workingDir);
  if (!root) return undefined;
  const completed = new Set<string>();
  // A skill already loaded this session satisfies `skill.view`: the idempotent
  // tool answers "already loaded", so demanding the re-view is a false block.
  if (loadedSkills.includes("ponytail")) completed.add("ponytail");
  const pending = new Map<string, ToolCallPayload[]>();
  for (const turn of turns) {
    if (turn.kind === "user") {
      // Call↔result pairing is per-turn, but prerequisite satisfaction is
      // per-session: once memory/graft/ponytail ran, they stay satisfied
      // across turn boundaries instead of being re-demanded every turn.
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
    const required = mutation ? ["memory", "graft", "stack", "ponytail"] : shell ? ["memory", "graft", "ponytail"] : ["memory", "graft"];
    const missing = required.filter(kind => !completed.has(kind));
    if (!missing.length) return null;
    const instructions: Record<string, string> = {
      memory: 'run .venv-dev/bin/python scripts/atomic_memory.py search "<topic>" from the project root',
      graft: 'run graft ask "<target symbol>" --source',
      ponytail: 'call skill.view({name:"ponytail"})',
      stack: 'run `bash ~/mcp-stack/ensure-stack.sh` and read the self: line',
    };
    return `Project workflow: before this call, ${missing.map(k => instructions[k]).join("; ")}. Complete prerequisites in earlier steps of this user turn. Keep normal approvals; report unavailable services instead of reading credentials.`;
  };
}
