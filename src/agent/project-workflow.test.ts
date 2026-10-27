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
    for (const attempts of [done(graft, "error"), done(graft, "ok", "exit: 1"), done(graft).slice(0, 1)]) {
      expect(projectWorkflowGuard(dir, [user(), ...done(memory), ...attempts])!(read)).toContain("graft ask");
    }
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
    expect(check({ tool: "os.fs.grep", args: { pattern: "symbol" } })).toContain("graft");
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
