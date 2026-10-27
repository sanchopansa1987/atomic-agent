import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "./blob-store.js";

describe("BlobStore.resolvePrefix", () => {
  it("resolves a unique prefix so a truncated pointer still pages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blobprefix-"));
    try {
      const store = new BlobStore({ rootDir: dir });
      const hash = await store.put("hello world");
      expect(await store.resolvePrefix(hash.slice(0, 12))).toBe(hash);
      expect(await store.resolvePrefix(hash)).toBe(hash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses what is not a pointer, and reports a miss as null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blobprefix-"));
    try {
      const store = new BlobStore({ rootDir: dir });
      await store.put("hello world");
      expect(await store.resolvePrefix("abc")).toBeNull();
      expect(await store.resolvePrefix("ffffffffffff")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
