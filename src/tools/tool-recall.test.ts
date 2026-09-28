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
    expect(result.summary).toBe(content.slice(0, 64_000));
    expect(result.truncated).toBe(true);
    expect(result.details.bytes).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("rejects malformed hashes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-tool-recall-"));
    dirs.push(dir);
    const store = new BlobStore({ rootDir: dir });

    await expect(
      buildToolRecallTool(store).run({ blob: "bad" }, {
        workingDir: dir,
        sessionId: "test",
        stepIndex: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/64-character/);
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
