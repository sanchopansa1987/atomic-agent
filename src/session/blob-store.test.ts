import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BlobStore } from "./blob-store.js";

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

test("put returns a 64-char hex hash", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const hash = await store.put("hello world");
    assert.match(hash, /^[a-f0-9]{64}$/);
  });
});

test("put is idempotent — same content, same hash, one file", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const h1 = await store.put("duplicate me");
    const h2 = await store.put("duplicate me");
    assert.equal(h1, h2);
    assert.equal(await countFiles(dir), 1);
  });
});

test("get returns the exact content that was put", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const content = "line one\nline two\nline three\n";
    const hash = await store.put(content);
    assert.equal(await store.get(hash), content);
  });
});

test("get returns null for a missing hash", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const missing = "a".repeat(64);
    assert.equal(await store.get(missing), null);
  });
});

test("get returns null for a malformed hash", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    assert.equal(await store.get("not-a-hash"), null);
    assert.equal(await store.get(""), null);
    assert.equal(await store.get("abcd"), null);
    assert.equal(await store.get("Z".repeat(64)), null);
  });
});

test("has returns true for stored, false for missing", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const hash = await store.put("present");
    assert.equal(await store.has(hash), true);
    assert.equal(await store.has("b".repeat(64)), false);
    assert.equal(await store.has("garbage"), false);
  });
});

test("different contents produce different hashes", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const h1 = await store.put("alpha");
    const h2 = await store.put("beta");
    assert.notEqual(h1, h2);
  });
});

test("gc with large budget removes nothing", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    await store.put("a".repeat(100));
    await store.put("b".repeat(100));
    const result = await store.gc(10_000);
    assert.equal(result.removed, 0);
    assert.equal(result.freedBytes, 0);
  });
});

test("gc with zero budget removes blobs", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    await store.put("x".repeat(100));
    await store.put("y".repeat(100));
    await store.put("z".repeat(100));
    const result = await store.gc(0);
    assert.ok(result.removed > 0, "gc should remove at least one blob");
    assert.ok(result.freedBytes > 0, "gc should free some bytes");
  });
});

test("sharding: hash prefix determines shard directory", async () => {
  await withTmp(async (dir) => {
    const store = new BlobStore({ rootDir: dir });
    const content = "shard check";
    const hash = await store.put(content);
    const shard = hash.slice(0, 2);
    const shardStat = await stat(join(dir, shard));
    assert.ok(shardStat.isDirectory(), `expected shard dir at ${shard}`);
  });
});
