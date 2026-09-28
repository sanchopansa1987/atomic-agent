import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressToolResult, RAW_TOOL_OUTPUT } from "../compressor/result-compressor.js";
import { BlobStore } from "../session/blob-store.js";
import { ToolRegistry, type ToolContext } from "./tool-registry.js";
import { buildToolRecallTool } from "./tool-recall.js";

describe("tool output storage", () => {
  let dir: string;
  let store: BlobStore;
  let ctx: ToolContext;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-tool-blob-"));
    store = new BlobStore({ rootDir: dir });
    ctx = { workingDir: dir, sessionId: "test", stepIndex: 0, signal: new AbortController().signal };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("stores original outputs before compression, including spread wrappers and concurrent errors", async () => {
    const registry = new ToolRegistry(store);
    const output = "original  \r\n\r\n" + "long line\n".repeat(1200);
    registry.register({
      name: "probe", description: "fixture", readonly: true,
      async run(args) {
        const body = `${String(args.label)}\n${output}`;
        // MCP and other wrappers may spread the compressor's return value.
        return { ...compressToolResult({ tool: "probe", status: args.fail ? "error" : "ok", output: body }) };
      },
    });
    const results = await Promise.all([
      registry.invoke("probe", { label: "first" }, ctx),
      registry.invoke("probe", { label: "second", fail: true }, ctx),
    ]);
    for (const [i, result] of results.entries()) {
      const label = i === 0 ? "first" : "second";
      expect(result.status).toBe(i === 0 ? "ok" : "error");
      expect(await store.get(result.blob!)).toBe(`${label}\n${output}`);
      expect(result.summary.length).toBeLessThan(500);
      expect(result[RAW_TOOL_OUTPUT]).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("original");
    }
    expect(results[0]!.blob).not.toBe(results[1]!.blob);
  });

  it("stores large direct summaries and leaves short and terminal results alone", async () => {
    const registry = new ToolRegistry(store);
    const put = vi.spyOn(store, "put");
    for (const name of ["probe", "reply", "finish"]) {
      registry.register({
        name, description: "fixture", readonly: true,
        async run(args) {
          return { tool: name, status: "ok", summary: String(args.text), details: {}, truncated: false };
        },
      });
    }
    const body = "z".repeat(9000);
    expect((await registry.invoke("probe", { text: "short" }, ctx)).blob).toBeUndefined();
    expect((await registry.invoke("reply", { text: body }, ctx)).blob).toBeUndefined();
    expect((await registry.invoke("finish", { text: body }, ctx)).blob).toBeUndefined();
    const saved = await registry.invoke("probe", { text: body }, ctx);
    expect(await store.get(saved.blob!)).toBe(body);
    expect(put).toHaveBeenCalledTimes(1);
    registry.register(buildToolRecallTool(store));
    await registry.invoke("tool.recall", { blob: saved.blob }, ctx);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("keeps the tool outcome when blob storage fails and advertises no false reference", async () => {
    vi.spyOn(store, "put").mockRejectedValue(new Error("disk full"));
    const registry = new ToolRegistry(store);
    const output = "value".repeat(2000);
    const result = compressToolResult({ tool: "probe", status: "ok", output, details: { savedFile: true } });
    registry.register({ name: "probe", description: "fixture", readonly: false, run: async () => result });
    const actual = await registry.invoke("probe", {}, ctx);
    expect(actual.status).toBe("ok");
    expect(actual.summary).toBe(result.summary);
    expect(actual.blob).toBeUndefined();
    expect(actual.details).toMatchObject({ savedFile: true, blobStoreError: expect.any(String) });
  });
});
