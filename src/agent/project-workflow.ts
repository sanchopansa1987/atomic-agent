import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ToolCallPayload } from "../llm/grammar/tool-call-grammar.js";
import type { ConversationTurn } from "../session/conversation-turn.js";

const MARKER = "## DSH memory rules (DeepSeek only)";
const SOURCE = /\.(?:py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|c|cpp|h|rb|sh)(?:$|[},])/i;
// A shell command that names no source file and runs none of these binaries
// cannot touch the project, so it needs no project context first. Conservative
// by construction: a widened regex can only ever gate MORE inspection commands,
// never skip a writer.
const MUTATORS = new Set([
  "rm", "rmdir", "mv", "cp", "chmod", "chown", "tee", "dd", "truncate", "ln",
  "mkdir", "touch", "git", "npm", "pip", "pip3", "python", "python3", "node",
  "npx", "docker", "sqlite3", "sed", "perl", "awk", "kill",
]);
// Read-only subcommands of the multiplexers above. `git status`, `git log` and
// `docker ps` are investigations, and the guard charged them as writes — the
// binary name decided, not the verb (audit 2026-11-04, defect 4). Per subcommand
// because `git rm` / `docker rm` are still mutators.
const READONLY: Record<string, ReadonlySet<string>> = {
  git: new Set(["status", "log", "show", "diff", "blame", "branch", "rev-parse",
    "ls-files", "remote", "grep", "config"]),
  docker: new Set(["ps", "images", "logs", "inspect", "version", "info"]),
};
function mutatorAt(argv: string[], i: number): boolean {
  const base = basename(argv[i]!);
  if (!MUTATORS.has(base)) return false;
  const allow = READONLY[base];
  return !(allow ? allow.has(argv[i + 1] ?? "") : false);
}
// Every file operation that can change or destroy a source file. `write/edit/patch`
// used to be the whole list, so deleting a source file was the only irreversible
// act with no prerequisites at all (audit 2026-11-04, defect 2).
const MUTATION_TOOLS = new Set([
  "os.fs.write", "os.fs.edit", "os.fs.patch",
  "os.fs.trash", "os.fs.restore", "os.fs.archive.extract",
]);

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
  // `;`, `&` and `|` are delimiters, not word characters: `graft ask x --source;`
  // used to lex as the single token `--source;`, so the `--source` test missed it and
  // the prerequisite credited nothing. Chains are the form the gate recommends, so
  // gluing a separator must not erase the run.
  const found = command.match(/"[^"]*"|'[^']*'|[;&|]+|[^\s"';&|]+/g) ?? [];
  return found.map(t => /^(".*"|'.*')$/.test(t) ? t.slice(1, -1) : t);
}

const SEPARATORS = new Set(["&&", "||", ";", "|", "&", "then", "do", "else"]);
// A token in command position is one a shell would execute: the head, the word
// after a separator, or the script handed to `bash`/`sh` (with or without `-c`).
// Argument positions are excluded on purpose — a *mention* of a prerequisite is
// not a run of it (audit 2026-11-04, defect 1).
function commandPosition(argv: string[], i: number): boolean {
  if (i === 0) return true;
  const prev = argv[i - 1]!;
  if (SEPARATORS.has(prev) || SHELL.test(basename(prev))) return true;
  return SHELL.test(basename(argv[0]!)) && i === 2;
}

// The binary that belongs to each prerequisite kind. A command that also runs a
// mutator outside this set is not a prerequisite: it used to hand out the credit
// and skip the gate entirely (audit 2026-11-04, defect 1).
const OWN: Record<string, RegExp> = {
  memory: /^python(?:3(?:\.\d+)?)?$/,
  sync: /^python(?:3(?:\.\d+)?)?$/,
  graft: /^graft$/,
  stack: /^(?:ba|z|da)?sh$/,
};
// Every binary that ANY prerequisite runs. This was checked one kind at a time, so
// a command carrying memory and graft looked foreign to the memory rule (python is
// in MUTATORS) and credited nothing: the batched form the refusal itself recommends
// was uncreditable, which is why satisfying the gate cost one model round per
// prerequisite (s-461b9d5d: refused 15:46:22 for memory, then 15:46:33 for graft).
const OWN_BINARY = new RegExp(`(?:${Object.values(OWN).map(re => re.source).join("|")})`);
function foreignMutator(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (!commandPosition(argv, i)) continue;
    const base = basename(argv[i]!);
    if (OWN_BINARY.test(base) || base === "cd") continue;
    if (mutatorAt(argv, i)) return base;
  }
  return null;
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

function prerequisites(call: ToolCallPayload, root: string, workingDir: string): string[] {
  if (call.tool === "skill.view" && call.args.name === "ponytail") return ["ponytail"];
  const argv = commandTokens(call);
  if (!argv.length) return [];
  // Every kind the call performs, not just the first one found: one batched command
  // used to credit a single prerequisite, so finishing the gate took one model round
  // per prerequisite (the 15:46:22 → 15:46:33 ladder).
  const found = new Set<string>();
  // A stack self-audit run satisfies its own prerequisite: the gate must never
  // demand a check it also blocks (that is a deadlock, not a rule). The script has
  // to be *executed*, though — `cat ~/mcp-stack/ensure-stack.sh` only names it and
  // used to hand out the credit (audit 2026-11-04, defect 1).
  if (argv.some((w, i) => w.includes("ensure-stack.sh") && commandPosition(argv, i))) {
    found.add("stack");
  }

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
    if (base === "graft" && argv[i + 1] === "ask") {
      // `--source` before or after the symbol — proof of run is not word order
      // (audit 2026-11-04, defect 6).
      const tail = argv.slice(i + 2, i + 8);
      if (tail.includes("--source") && tail.some(w => !w.startsWith("--") && w.trim().length)) {
        found.add("graft");
      }
    }
    if (!/^python(?:3(?:\.\d+)?)?$/.test(base) || typeof argv[i + 1] !== "string") continue;
    const script = resolve(cwd, argv[i + 1]!);
    if (script !== memScript) continue;
    if (argv[i + 2] === "search" && argv[i + 3]?.trim().length) found.add("memory");
    if (argv[i + 2] === "sync" && resolve(cwd, argv[i + 3] ?? "") === syncScript) found.add("sync");
  }
  if (!found.size) return [];
  // A command that also runs a mutator outside the prerequisite binaries is not a
  // prerequisite: it used to collect the credit and skip the gate entirely, which is
  // how `rm -rf src/x.ts <path>/ensure-stack.sh` ran unguarded (audit 2026-11-04,
  // defect 1). The set above is what makes the batch self-serving: memory and graft
  // in one command credit both instead of only the first.
  if (foreignMutator(argv)) return [];
  return [...found];
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
  // Prerequisites that ran and came back not-ok. They stay incomplete, as they
  // must, but the refusal names them: a broken dependency (graft down, memory DB
  // locked) used to be re-demanded as "never attempted" forever, with no
  // diagnostic (audit 2026-11-04, defect 3).
  const failed = new Map<string, string>();
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
      const kinds = prerequisites(call, root, workingDir);
      // skill.view is idempotent: viewing an already-loaded skill answers with a
      // no-op/duplicate result, never `ok`. Requiring `ok` here deadlocked every
      // later turn — the guard demanded an event the tool could no longer produce,
      // so shell and source edits stayed refused forever. Asking for the skill at
      // all is proof it was read; re-reading it is not a second requirement.
      if (kinds.includes("ponytail")) { completed.add("ponytail"); continue; }
      if (turn.status !== "ok") { for (const kind of kinds) failed.set(kind, turn.status); continue; }
      // `turn.status` is the tool's own verdict and the only durable proof of
      // the run. The old extra test — `exit: 0` must appear in `turn.summary` —
      // read compliance out of presentation text: the transcript compressor
      // rewrites and elides summaries, so a prerequisite that genuinely ran
      // stopped counting once its result was packed, and every later turn
      // re-demanded memory search + graft ask. That is two extra model rounds
      // per turn (~16s at 8s decode each, measured on s-7e53420c). Compliance
      // is not a prose property.
      for (const kind of kinds) if (kind !== "sync") completed.add(kind);
    }
  }
  return call => {
    const argv = commandTokens(call);
    const sourcePath = [call.args.path, call.args.paths, call.args.pattern, call.args.glob]
      .flatMap(value => Array.isArray(value) ? value : [value])
      .some(value => typeof value === "string" && SOURCE.test(value));
    // A probe that names no source file and runs no mutator cannot touch the
    // project — `launchctl print`, `ps`, `curl …/getMe`, `cat ~/.atomic-agent/…`.
    // Requiring the batch for it costs two model rounds (~16s at the measured 8s
    // decode each) and reads nothing the prompt already lacks. ponytail: ceiling
    // = a probe that reaches source over the network; add its binary to MUTATORS
    // the day one starts carrying context.
    const shell = call.tool === "os.shell.run" &&
      argv.some((w, i) => SOURCE.test(w) || mutatorAt(argv, i));
    // Deletion is the one irreversible step, and it used to be the only file
    // operation with no prerequisites at all: the list named write/edit/patch
    // only, and `paths` — the trash/restore argument — was not even scanned
    // (audit 2026-11-04, defect 2).
    const mutation = MUTATION_TOOLS.has(call.tool) && sourcePath;
    // grep was gated over every tree while read was gated only over source: the
    // same file cost two model rounds one way and nothing the other
    // (audit 2026-11-04, defect 5).
    const lookup = ["os.fs.grep", "os.fs.read", "os.fs.glob"].includes(call.tool) && sourcePath;
    if (!shell && !mutation && !lookup) return null;
    // The prerequisite short-circuit belongs AFTER the classification: running it
    // first let one mention of ensure-stack.sh wave a source deletion through
    // with zero prerequisites (audit 2026-11-04, defect 1).
    if (prerequisites(call, root, workingDir).length) return null;
    const required = mutation ? ["memory", "graft", "stack", "ponytail"] : shell ? ["memory", "graft", "ponytail"] : ["memory", "graft"];
    const missing = required.filter(kind => !completed.has(kind));
    if (!missing.length) return null;
    // Root cause of the refusal ladder (s-461b9d5d: refused 15:46:22 for memory,
    // then 15:46:33 for graft; the same pair reproduced twice on 2026-11-04 —
    // memory+graft satisfied, then a mutation refused for `stack` alone). The
    // refusal listed the prerequisites as separate prose fragments, so a retry that
    // did exactly what the message showed satisfied one and was refused for the
    // next: one extra model round per prerequisite. The gate already accepts a
    // single `bash -lc` carrying them all (commandTokens flattens the script, the
    // defect-1 fix above), so the message has to hand back that exact batched form.
    // One retry, never N.
    const commands: Record<string, string> = {
      // No `<angle>` placeholders: the tokenizer reads them as redirections, so the
      // suggested line credited nothing (caught by the batched-command test).
      memory: '.venv-dev/bin/python scripts/atomic_memory.py search "your-topic"',
      graft: 'graft ask "src/agent/project-workflow.ts" --source',
      stack: "bash ~/mcp-stack/ensure-stack.sh",
    };
    const shellable = missing.filter(kind => kind !== "ponytail");
    // skill.view cannot ride in a shell line: name that call, then the one command.
    const skill = missing.includes("ponytail") ? 'call skill.view({name:"ponytail"}) once, then run ' : "run ";
    const retry = shellable.length > 1
      ? `${skill}bash -lc 'cd ${root} && ${shellable.map(kind => `${commands[kind]};`).join(" ")}', then repeat your call`
      : `${skill}${shellable.map(kind => commands[kind]).join("; ")}`;
    const stuck = missing.filter(kind => failed.has(kind));
    const note = stuck.length
      ? ` Already attempted this session and came back not-ok: ${stuck.map(k => `${k} (${failed.get(k)})`).join(", ")} — repair that first; repeating the same call fails the same way.`
      : "";
    return `Project workflow: ${missing.join(" + ")} not satisfied yet — ${retry}.${note} Keep normal approvals; report unavailable services instead of reading credentials.`;
  };
}
