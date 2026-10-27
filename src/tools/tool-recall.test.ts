import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../session/blob-store.js";
import { buildToolRecallTool } from "./tool-recall.js";

describe("tool.recall", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("returns the exact stored content and blob metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-tool-recall-"));
    dirs.push(dir);
    const store = new BlobStore({ rootDir: dir });
    const content = "first line  \r\n\r\nsecond line\n\n";
    const blob = await store.put(content);
    const result = await buildToolRecallTool(store).run({ blob }, {
      workingDir: dir,
      sessionId: "test",
      stepIndex: 0,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe(content);
    expect(result.details).toEqual({
      blob,
      bytes: Buffer.byteLength(content, "utf8"),
      offset: 0,
    });
    expect(result.truncated).toBe(false);
  });

  it("bounds large output and marks it truncated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-tool-recall-"));
    dirs.push(dir);
    const store = new BlobStore({ rootDir: dir });
    const content = "line\n".repeat(20_000);
    const blob = await store.put(content);
    const result = await buildToolRecallTool(store).run({ blob }, {
      workingDir: dir,
      sessionId: "test",
      stepIndex: 0,
      signal: new AbortController().signal,
    });
    expect(result.summary).toBe(content.slice(0, 8_000));
    expect(result.details.nextOffset).toBe(8_000);
    expect(result.truncated).toBe(true);
    expect(result.details.bytes).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("rejects malformed hashes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-tool-recall-"));
    dirs.push(dir);
    const store = new BlobStore({ rootDir: dir });

    await expect(
      buildToolRecallTool(store).run({ blob: "BAD-INPUT!" }, {
        workingDir: dir,
        sessionId: "test",
        stepIndex: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/64-character/);
  });

  it("routes a numeric row id to memory.procedures.recall instead of failing opaquely", async () => {
    // Root-cause guard: `tool.recall` pages a blob by hash, but "recall" got
    // called with a numeric memory/procedure id for a whole no-progress loop.
    const dir = await mkdtemp(join(tmpdir(), "atomic-tool-recall-"));
    dirs.push(dir);
    const store = new BlobStore({ rootDir: dir });
    const ctx = { workingDir: dir, sessionId: "test", stepIndex: 0, signal: new AbortController().signal };

    await expect(buildToolRecallTool(store).run({ blob: 2889 }, ctx))
      .rejects.toThrow(/memory\.procedures\.recall/);
    await expect(buildToolRecallTool(store).run({ blob: "2889" }, ctx))
      .rejects.toThrow(/memory\.procedures\.recall/);
  });

  it("routes a hex-looking row reference to memory.procedures.recall, noting ids are numeric", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-tool-recall-"));
    dirs.push(dir);
    const store = new BlobStore({ rootDir: dir });
    const ctx = { workingDir: dir, sessionId: "test", stepIndex: 0, signal: new AbortController().signal };

    await expect(buildToolRecallTool(store).run({ blob: "deadbeef" }, ctx))
      .rejects.toThrow(/memory\.procedures\.recall/);
    await expect(buildToolRecallTool(store).run({ blob: "1a2b" }, ctx))
      .rejects.toThrow(/memory\.procedures\.recall/);
  });

  it("names the alternative tool when a valid hash is not stored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-tool-recall-"));
    dirs.push(dir);
    const store = new BlobStore({ rootDir: dir });
    const missing = "0".repeat(64);

    await expect(
      buildToolRecallTool(store).run({ blob: missing }, {
        workingDir: dir,
        sessionId: "test",
        stepIndex: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/blob not found/);
    await expect(
      buildToolRecallTool(store).run({ blob: missing }, {
        workingDir: dir,
        sessionId: "test",
        stepIndex: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/memory\.procedures\.recall/);
  });

  it("recovers the entire original, including content beyond the old 64000-character ceiling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-tool-recall-"));
    dirs.push(dir);
    const store = new BlobStore({ rootDir: dir });
    const content = "α  \r\n\r\n😀\n".repeat(9000) + "FINAL MARKER";
    const blob = await store.put(content);
    const tool = buildToolRecallTool(store);
    const ctx = { workingDir: dir, sessionId: "test", stepIndex: 0, signal: new AbortController().signal };
    let recovered = "";
    let offset = 0;
    while (offset < content.length) {
      const result = await tool.run({ blob, offset }, ctx);
      expect(result.summary.length).toBeGreaterThan(0);
      expect(result.summary.length).toBeLessThanOrEqual(8000);
      recovered += result.summary;
      offset += result.summary.length;
      expect(result.truncated).toBe(offset < content.length);
      expect(result.details.nextOffset).toBe(offset < content.length ? offset : undefined);
    }
    expect(recovered).toBe(content);
    expect((await tool.run({ blob, offset: content.length }, ctx)).summary).toBe("");
    for (const args of [{ offset: -1 }, { offset: 1.5 }, { offset: null }, { offset: content.length + 1 }, { limit: 0 }, { limit: 8001 }]) {
      await expect(tool.run({ blob, ...args }, ctx)).rejects.toThrow(/tool.recall/);
    }
  });

  it("rejects a valid hash that is not stored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-tool-recall-"));
    dirs.push(dir);
    const store = new BlobStore({ rootDir: dir });
    const missing = "0".repeat(64);

    await expect(
      buildToolRecallTool(store).run({ blob: missing }, {
        workingDir: dir,
        sessionId: "test",
        stepIndex: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/blob not found/);
  });
});
