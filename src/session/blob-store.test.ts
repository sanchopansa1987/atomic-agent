import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, stat, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BlobStore } from "./blob-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});

afterEach(() => vi.mocked(unlink).mockClear());

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "blobstore-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function countFiles(root: string): Promise<number> {
  let n = 0;
  for (const shard of await readdir(root)) {
    const files = await readdir(join(root, shard));
    n += files.length;
  }
  return n;
}

it("put returns a 64-char hex hash", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const hash = await store.put("hello world");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

it("put is idempotent — same content, same hash, one file", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const h1 = await store.put("duplicate me");
    const h2 = await store.put("duplicate me");
    expect(h1).toBe(h2);
    expect(await countFiles(dir)).toBe(1);
  });
});

it("get returns the exact content that was put", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const content = "line one\nline two\nline three\n";
    const hash = await store.put(content);
    expect(await store.get(hash)).toBe(content);
  });
});

it("get returns null for a missing hash", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const missing = "a".repeat(64);
    expect(await store.get(missing)).toBeNull();
  });
});

it("get returns null for a malformed hash", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    expect(await store.get("not-a-hash")).toBeNull();
    expect(await store.get("")).toBeNull();
    expect(await store.get("abcd")).toBeNull();
    expect(await store.get("Z".repeat(64))).toBeNull();
  });
});

it("has returns true for stored, false for missing", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const hash = await store.put("present");
    expect(await store.has(hash)).toBe(true);
    expect(await store.has("b".repeat(64))).toBe(false);
    expect(await store.has("garbage")).toBe(false);
  });
});

it("different contents produce different hashes", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const h1 = await store.put("alpha");
    const h2 = await store.put("beta");
    expect(h1).not.toBe(h2);
  });
});

it("gc with large budget removes nothing", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    await store.put("a".repeat(100));
    await store.put("b".repeat(100));
    const result = await store.gc(10_000);
    expect(result.removed).toBe(0);
    expect(result.freedBytes).toBe(0);
  });
});

it("gc with zero budget removes blobs", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    await store.put("x".repeat(100));
    await store.put("y".repeat(100));
    await store.put("z".repeat(100));
    const result = await store.gc(0);
    expect(result.removed).toBeGreaterThan(0);
    expect(result.freedBytes).toBeGreaterThan(0);
  });
});

it("sharding: hash prefix determines shard directory", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const content = "shard check";
    const hash = await store.put(content);
    const shard = hash.slice(0, 2);
    const shardStat = await stat(join(dir, shard));
    expect(shardStat.isDirectory(), `expected shard dir at ${shard}`).toBe(true);
  });
});

it("gc removes expired blobs but keeps fresh", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const hOld = await store.put("old blob");
    const hFresh = await store.put("fresh blob");
    const oldPath = join(dir, hOld.slice(0, 2), hOld.slice(2));
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    await utimes(oldPath, new Date(twoDaysAgo), new Date(twoDaysAgo));
    const result = await store.gc(10_000, 24 * 60 * 60 * 1000);
    expect(result.removed).toBe(1);
    expect(await store.has(hOld)).toBe(false);
    expect(await store.has(hFresh)).toBe(true);
  });
});

it("gc with age limit and byte budget cleans both", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const h1 = await store.put("a".repeat(100));
    const h2 = await store.put("b".repeat(100));
    const h3 = await store.put("c".repeat(100));
    const p1 = join(dir, h1.slice(0, 2), h1.slice(2));
    const p2 = join(dir, h2.slice(0, 2), h2.slice(2));
    const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await utimes(p1, new Date(oldTime), new Date(oldTime));
    const recentTime = new Date(Date.now() - 60_000);
    await utimes(p2, recentTime, recentTime);
    // Age removes h1; the budget must then remove the older fresh blob h2.
    const result = await store.gc(150, 24 * 60 * 60 * 1000);
    expect(result).toEqual({ removed: 2, freedBytes: 200 });
    expect(await store.has(h1)).toBe(false);
    expect(await store.has(h2)).toBe(false);
    expect(await store.has(h3)).toBe(true);
  });
});

it("gc preserves old blobs when the age limit is omitted", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const hOld = await store.put("old");
    const hNew = await store.put("new");
    const oldPath = join(dir, hOld.slice(0, 2), hOld.slice(2));
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(oldPath, oldTime, oldTime);
    expect(await store.gc(10_000)).toEqual({ removed: 0, freedBytes: 0 });
    expect(await store.has(hOld)).toBe(true);
    expect(await store.has(hNew)).toBe(true);
  });
});

it("gc still counts expired blobs whose deletion fails against the byte budget", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const old = await store.put("a".repeat(100));
    const fresh = await store.put("b".repeat(100));
    const oldPath = join(dir, old.slice(0, 2), old.slice(2));
    const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(oldPath, oldTime, oldTime);
    vi.mocked(unlink).mockRejectedValueOnce(new Error("permission denied"));

    expect(await store.gc(150, 24 * 60 * 60 * 1000)).toEqual({
      removed: 1,
      freedBytes: 100,
    });
    expect(await store.has(old)).toBe(true);
    expect(await store.has(fresh)).toBe(false);
  });
});
