import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectWorkflowGuard } from "./project-workflow.js";
import { executeBatch, toBatchInputs } from "./batch-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { ConversationTurn } from "../session/conversation-turn.js";
import type { ToolCallPayload } from "../llm/grammar/tool-call-grammar.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function root(marked = true) {
  const dir = mkdtempSync(join(tmpdir(), "atomic-workflow-")); roots.push(dir);
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts/atomic_memory.py"), "# fixture");
  writeFileSync(join(dir, "AGENTS.md"), marked ? "## DSH memory rules (DeepSeek only)" : "# Other project");
  return dir;
}
const user = (): ConversationTurn => ({ kind: "user", text: "task", at: 1 });
const memory: ToolCallPayload = { tool: "os.shell.run", args: { cmd: "python3", args: ["scripts/atomic_memory.py", "search", "topic"] } };
const graft: ToolCallPayload = { tool: "os.shell.run", args: { cmd: "graft", args: ["ask", "symbol", "--source"] } };
const ponytail: ToolCallPayload = { tool: "skill.view", args: { name: "ponytail" } };
// mutation now also requires a stack self-audit run (see project-workflow.ts)
const stack: ToolCallPayload = { tool: "os.shell.run", args: { cmd: "bash", args: ["~/mcp-stack/ensure-stack.sh"] } };
const read: ToolCallPayload = { tool: "os.fs.read", args: { path: "a.py" } };
const write: ToolCallPayload = { tool: "os.fs.write", args: { path: "a.py", content: "pass" } };
function done(call: ToolCallPayload, status: "ok" | "error" = "ok", summary = "exit: 0"): ConversationTurn[] {
  return [{ kind: "assistant_tool_call", ...call, at: 2 }, { kind: "tool_result", tool: call.tool, status, summary, at: 3 }];
}
const ready = () => [user(), ...done(memory), ...done(graft), ...done(ponytail), ...done(stack)];

describe("project workflow", () => {
  it("is opt-in and finds the marked ancestor", () => {
    expect(projectWorkflowGuard(root(false), [])).toBeUndefined();
    const dir = root(); mkdirSync(join(dir, "nested"));
    expect(projectWorkflowGuard(join(dir, "nested"), [])!(read)).toContain("atomic_memory.py");
  });
  it("keeps prerequisites, Markdown and metadata reachable", () => {
    const check = projectWorkflowGuard(root(), [user()])!;
    for (const call of [memory, graft, ponytail, stack, { tool: "tool.view", args: { name: "skill.view" } },
      { tool: "reply", args: { text: "blocked" } }, { tool: "os.fs.read", args: { path: "TASK.md" } },
      { tool: "os.fs.list", args: { path: "." } }]) expect(check(call)).toBeNull();
  });
  it("requires memory and Graft before lookup, then Ponytail before mutation or shell", () => {
    const dir = root();
    expect(projectWorkflowGuard(dir, [user(), ...done(memory)])!(read)).toContain("graft ask");
    const looked = [user(), ...done(memory), ...done(graft)];
    expect(projectWorkflowGuard(dir, looked)!(read)).toBeNull();
    expect(projectWorkflowGuard(dir, looked)!(write)).toContain("ponytail");
    expect(projectWorkflowGuard(dir, looked)!({ tool: "os.shell.run", args: { cmd: "python3", args: ["-c", "pass"] } })).toContain("ponytail");
    expect(projectWorkflowGuard(dir, ready())!(write)).toBeNull();
  });
  it("rejects failed, denied and pending evidence", () => {
    const dir = root();
    // `done(graft, "ok", "exit: 1")` used to be a case here. It is unreachable:
    // shell-result.ts:136 derives `status` from the exit code
    // (`exitCode === 0 ? "ok" : "error"`), so an ok result never carries a
    // failing exit. The fixture was really asserting "read the exit out of the
    // summary text", which the compressor rewrites — that assertion is what made
    // every later turn re-demand the prerequisites.
    for (const attempts of [done(graft, "error"), done(graft).slice(0, 1)]) {
      expect(projectWorkflowGuard(dir, [user(), ...done(memory), ...attempts])!(read)).toContain("graft ask");
    }
  });
  it("spares inspection probes the prerequisite batch but gates mutators", () => {
    const dir = root();
    const probe: ToolCallPayload = { tool: "os.shell.run", args: { cmd: "launchctl", args: ["print", "gui/501/com.kst.atomic-tg-bridge"] } };
    expect(projectWorkflowGuard(dir, [user()])!(probe)).toBeNull();
    // `git status` used to be in the gated list: the guard classified by binary
    // name, so it charged a read as a write (audit 2026-11-04, defect 4).
    expect(projectWorkflowGuard(dir, [user()])!({ tool: "os.shell.run", args: { cmd: "git", args: ["status"] } })).toBeNull();
    expect(projectWorkflowGuard(dir, [user()])!({ tool: "os.shell.run", args: { cmd: "git", args: ["rm", "a.py"] } })).toContain("memory");
    for (const gated of [
      { tool: "os.shell.run", args: { cmd: "python3", args: ["-c", "pass"] } },
      { tool: "os.shell.run", args: { cmd: "cat", args: ["src/agent/project-workflow.ts"] } },
    ] as ToolCallPayload[]) expect(projectWorkflowGuard(dir, [user()])!(gated)).toContain("memory");
  });
  it("counts a prerequisite whose summary the compressor elided", () => {
    const dir = root();
    // The invariant, expressed behaviourally: compliance may depend only on
    // `turn.status`. An empty summary is what compaction leaves behind, and it
    // must not resurrect a completed prerequisite. This is the regression guard
    // for the prose-derived control flow that cost two model rounds per turn.
    const elided: ConversationTurn[] = [
      { kind: "assistant_tool_call", ...memory, at: 2 },
      { kind: "tool_result", tool: memory.tool, status: "ok", summary: "", at: 3 },
    ];
    const check = projectWorkflowGuard(dir, [user(), ...elided])!;
    expect(check(read)).toContain("graft ask");
    expect(check(read)).not.toContain("atomic_memory.py");
  });
  it("carries satisfied prerequisites across turn boundaries", () => {
    const dir = root();
    expect(projectWorkflowGuard(dir, [...ready(), user()])!(write)).toBeNull();
  });
  it("treats a skill in the loaded set as satisfying skill.view", () => {
    const dir = root();
    const turned = [user(), ...done(memory), ...done(graft), ...done(stack)];
    expect(projectWorkflowGuard(dir, turned, ["ponytail"])!(write)).toBeNull();
    expect(projectWorkflowGuard(dir, turned)!(write)).toContain("ponytail");
  });
  it("still blocks when nothing ran", () => {
    const dir = root();
    expect(projectWorkflowGuard(dir, [user()])!(read)).toContain("atomic_memory.py");
    expect(projectWorkflowGuard(dir, [user()])!(write)).toContain("atomic_memory.py");
  });
  it("does not count forged shell chains, a different helper, or sync as recall", () => {
    const dir = root();
    for (const call of [
      { tool: "os.shell.run", args: { cmd: "graft ask x --source; echo done", args: [] } },
      { tool: "os.shell.run", args: { cmd: "python3", args: ["other.py", "search", "topic"] } },
      { tool: "os.shell.run", args: { cmd: "python3", args: ["scripts/atomic_memory.py", "sync", "vault/agent-memory/MEMORY_WORKFLOW_2026-10-01.md"] } },
    ]) expect(projectWorkflowGuard(dir, [user(), ...done(call)])!(read)).not.toBeNull();
  });
  it("counts a repeat skill.view as Ponytail even when the result is a no-op", () => {
    const dir = root();
    // A second view of an already-loaded skill answers "already loaded"/duplicate,
    // never `ok`. Requiring `ok` here deadlocked every later turn: the guard asked
    // for an event the idempotent tool could no longer produce.
    const repeated = done(ponytail, "error", "duplicate tool-result-v1");
    expect(projectWorkflowGuard(dir, [user(), ...done(memory), ...done(graft), ...done(stack), ...repeated])!(write)).toBeNull();
  });
  it("accepts simple quoted commands and correctly paired parallel results", () => {
    const m = { tool: "os.shell.run", args: { cmd: 'python3 scripts/atomic_memory.py search "a topic"', args: [] } };
    const g = { tool: "os.shell.run", args: { cmd: 'graft ask "a symbol" --source', args: [] } };
    const turns = [user(), done(m)[0]!, done(g)[0]!, done(m)[1]!, done(g)[1]!];
    expect(projectWorkflowGuard(root(), turns)!(read)).toBeNull();
  });
  it("accepts a shell-wrapped simple prerequisite instead of deadlocking", () => {
    const dir = root();
    // `bash -lc "cd <root> && ..."` is what an agent writes when the call has no
    // `cwd`. It used to satisfy nothing, and the refusal forbade the only form
    // that would — steps 88, 20 refused calls, no way back in.
    const wrapped = (cmd: string) => ({ tool: "os.shell.run", args: { cmd: "bash", args: ["-lc", cmd] } });
    const m = wrapped(`cd ${dir} && .venv-dev/bin/python scripts/atomic_memory.py search guide`);
    const g = wrapped('graft ask "a symbol" --source');
    expect(projectWorkflowGuard(dir, [user(), ...done(m), ...done(g)])!(read)).toBeNull();
    // Chains and substitutions past the `cd` prefix still count for nothing.
    expect(projectWorkflowGuard(dir, [user(), ...done(m), ...done(wrapped("graft ask x --source; rm -rf /"))])!(read)).toContain("graft ask");
  });
  it("blocks source searches as well as direct reads", () => {
    const check = projectWorkflowGuard(root(), [user()])!;
    expect(check({ tool: "os.fs.glob", args: { pattern: "**/*.ts" } })).toContain("graft");
    expect(check({ tool: "os.fs.glob", args: { pattern: ["docs/*.md", "src/index.ts"] } })).toContain("graft");
    expect(check({ tool: "os.fs.glob", args: { pattern: ["docs/*.md"] } })).toBeNull();
    // A grep is priced by its scope, like a read. Gating every grep gave the same
    // docs file two different prices depending on which tool opened it
    // (audit 2026-11-04, defect 5).
    expect(check({ tool: "os.fs.grep", args: { pattern: "symbol" } })).toBeNull();
    expect(check({ tool: "os.fs.grep", args: { pattern: "symbol", glob: "**/*.ts" } })).toContain("graft");
  });
  it("never invokes blocked targets, and retains normal approvals for allowed calls", async () => {
    const dir = root(); const target = vi.fn(); const approved = vi.fn(async () => ({ tool: "os.fs.write", status: "error" as const, summary: "approval denied", details: {}, truncated: false }));
    const reg = new ToolRegistry();
    reg.register({ name: "os.fs.read", description: "read", readonly: true, run: target });
    reg.register({ name: "os.fs.write", description: "write", readonly: false, run: approved });
    const ctx = { workingDir: dir, sessionId: "test", stepIndex: 1, signal: new AbortController().signal };
    const blocked = await executeBatch(toBatchInputs([read]), reg, { ...ctx, workflowGuard: projectWorkflowGuard(dir, [user()])! });
    expect(target).not.toHaveBeenCalled();
    expect(blocked.results[0]?.compressed?.details.projectWorkflowBlocked).toBe(true);
    const allowed = await executeBatch(toBatchInputs([write]), reg, { ...ctx, workflowGuard: projectWorkflowGuard(dir, ready())! });
    expect(approved).toHaveBeenCalledOnce();
    expect(allowed.results[0]?.compressed?.summary).toBe("approval denied");
  });
  it("a prerequisite in the same batch cannot unlock a sibling", async () => {
    const dir = root(); const target = vi.fn(); const reg = new ToolRegistry();
    reg.register({ name: "os.shell.run", description: "lookup", readonly: false, run: async () => ({ tool: "os.shell.run", status: "ok", summary: "exit: 0", details: {}, truncated: false }) });
    reg.register({ name: "os.fs.read", description: "read", readonly: true, run: target });
    await executeBatch(toBatchInputs([graft, read]), reg, { workingDir: dir, sessionId: "test", stepIndex: 1,
      signal: new AbortController().signal, workflowGuard: projectWorkflowGuard(dir, [user(), ...done(memory)])! });
    expect(target).not.toHaveBeenCalled();
  });
});

// Regressions for the 2026-11-04 audit (docs/AUDIT_2026-11-04_project-workflow-guard.md).
describe("guard defects found by the 2026-11-04 audit", () => {
  it("does not let a mention of ensure-stack.sh wave a source deletion through", () => {
    const dir = root();
    // defect 1: prerequisite() ran before the classification and accepted any
    // token containing the script name, so this ran with zero prerequisites.
    const mixed: ToolCallPayload = { tool: "os.shell.run", args: { cmd: "rm", args: ["-rf", "src/x.ts", "~/mcp-stack/ensure-stack.sh"] } };
    expect(projectWorkflowGuard(dir, [user()])!(mixed)).toContain("memory");
    // ... and naming the script is not running it: no `stack` credit, so the
    // mutation stays blocked on exactly that prerequisite.
    const named: ToolCallPayload = { tool: "os.shell.run", args: { cmd: "cat", args: ["~/mcp-stack/ensure-stack.sh"] } };
    const turns = [user(), ...done(memory), ...done(graft), ...done(ponytail), ...done(named)];
    expect(projectWorkflowGuard(dir, turns)!(write)).toContain("stack");
  });
  it("gates deleting a source file as a mutation", () => {
    // defect 2: write/edit/patch were the whole list, so the one irreversible
    // operation needed no prerequisites at all.
    const dir = root();
    const del: ToolCallPayload = { tool: "os.fs.trash", args: { paths: ["a.py"] } };
    expect(projectWorkflowGuard(dir, [user()])!(del)).toContain("memory");
    expect(projectWorkflowGuard(dir, ready())!(del)).toBeNull();
  });
  it("names a prerequisite that ran and came back not-ok", () => {
    // defect 3: a crashed prerequisite was re-demanded as "never run".
    const dir = root();
    const check = projectWorkflowGuard(dir, [user(), ...done(memory), ...done(graft, "error")])!;
    expect(check(read)).toContain("came back not-ok");
    expect(check(read)).toContain("graft (error)");
  });
  it("hands back one batched command so a refusal cannot ladder", () => {
    // defect 7: the refusal listed memory, graft and stack as three separate prose
    // fragments, so a retry that did exactly what it showed satisfied one and was
    // refused for the next — one extra model round per prerequisite (s-461b9d5d
    // 15:46:22 memory, 15:46:33 graft).
    const dir = root();
    const message = projectWorkflowGuard(dir, [user()])!(write)!;
    const script = message.match(/bash -lc '([^']+)'/)?.[1];
    expect(script, "the refusal must hand back a runnable batched command").toBeTruthy();
    // Carrying out ONLY that one command satisfies every shell prerequisite at once:
    // one round, not one per prerequisite (the 15:46:22 memory / 15:46:33 graft
    // ladder). ponytail is a tool call and cannot ride in a shell line, so it stays.
    const batch: ToolCallPayload = { tool: "os.shell.run", args: { cmd: "bash", args: ["-lc", script!] } };
    const after = projectWorkflowGuard(dir, [user(), ...done(batch)])!(write)!;
    expect(after).toMatch(/^Project workflow: ponytail not satisfied yet/);
  });
});
