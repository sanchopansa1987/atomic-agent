import { describe, expect, it } from "vitest";
import { compressToolResult } from "../compressor/result-compressor.js";
import { ToolRegistry, type ToolContext } from "./tool-registry.js";

/**
 * The memo exists because 1,098 of 4,125 distinct tool calls in the recorded
 * traces were re-invocations of a signature already satisfied in the same
 * session (`skill.view ponytail` x83). These tests pin the two ways it can be
 * wrong: serving a stale body after the world changed, and caching a failure.
 */

const ctx: ToolContext = {
  workingDir: "/tmp",
  sessionId: "memo-test",
  stepIndex: 0,
  signal: new AbortController().signal,
};

function fixture(name: string, status: "ok" | "error" = "ok") {
  let runs = 0;
  return {
    runs: () => runs,
    definition: {
      name,
      description: "fixture",
      readonly: true,
      async run(args: Record<string, unknown>) {
        runs += 1;
        return compressToolResult(
          { tool: name, status, output: `body ${runs} q=${String(args.q ?? "")}` },
          { maxSummaryLength: 500, maxTailLines: 10 },
        );
      },
    },
  };
}

describe("tool result memo", () => {
  it("serves the second identical call without running the tool", async () => {
    const fx = fixture("os.fs.read");
    const registry = new ToolRegistry();
    registry.register(fx.definition);

    const first = await registry.invoke("os.fs.read", { path: "/tmp/a" }, ctx);
    const second = await registry.invoke("os.fs.read", { path: "/tmp/a" }, ctx);

    expect(fx.runs()).toBe(1);
    expect(second.summary).toBe(first.summary);
    expect(first.details?.memo).toBeUndefined();
    expect(second.details?.memo).toBe("reused");
  });

  it("keys on the args, so a different argument still runs", async () => {
    const fx = fixture("os.fs.read");
    const registry = new ToolRegistry();
    registry.register(fx.definition);

    await registry.invoke("os.fs.read", { path: "/tmp/a" }, ctx);
    await registry.invoke("os.fs.read", { path: "/tmp/b" }, ctx);

    expect(fx.runs()).toBe(2);
  });

  it("ignores argument order, because the model emits keys in any order", async () => {
    const fx = fixture("os.fs.grep");
    const registry = new ToolRegistry();
    registry.register(fx.definition);

    await registry.invoke("os.fs.grep", { pattern: "x", path: "/tmp" }, ctx);
    await registry.invoke("os.fs.grep", { path: "/tmp", pattern: "x" }, ctx);

    expect(fx.runs()).toBe(1);
  });

  it("clears on a mutating tool, so a read after an edit is never stale", async () => {
    const read = fixture("os.fs.read");
    const shell = fixture("os.shell.run");
    const registry = new ToolRegistry();
    registry.register(read.definition);
    registry.register(shell.definition);

    await registry.invoke("os.fs.read", { path: "/tmp/a" }, ctx);
    await registry.invoke("os.shell.run", { cmd: "true" }, ctx);
    await registry.invoke("os.fs.read", { path: "/tmp/a" }, ctx);

    expect(read.runs()).toBe(2);
  });

  it("never memoises a tool that is not on the safe list", async () => {
    const shell = fixture("os.shell.run");
    const registry = new ToolRegistry();
    registry.register(shell.definition);

    await registry.invoke("os.shell.run", { cmd: "pwd" }, ctx);
    await registry.invoke("os.shell.run", { cmd: "pwd" }, ctx);

    expect(shell.runs()).toBe(2);
  });

  it("never memoises an error result", async () => {
    const fx = fixture("os.fs.read", "error");
    const registry = new ToolRegistry();
    registry.register(fx.definition);

    const first = await registry.invoke("os.fs.read", { path: "/tmp/a" }, ctx);
    expect(first.status).toBe("error");
    await registry.invoke("os.fs.read", { path: "/tmp/a" }, ctx);

    expect(fx.runs()).toBe(2);
  });
});
