/**
 * Content-addressed blob store for tool-result bodies.
 *
 * Tool results (file reads, shell output, MCP responses) can be large.
 * Storing them in full inside `SessionState.turns` means the prompt has
 * to carry every byte forever. Instead the caller `put()`s the body once
 * and keeps the returned sha256 hash on the turn; the prompt reads back
 * only what it needs, when it needs it.
 *
 * Layout: `<rootDir>/<first-2-hex>/<remaining-62-hex>`.
 * Writes are idempotent (same content = same path = no rewrite).
 * `gc()` drops oldest-first when the store exceeds a byte budget.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface BlobStoreOptions {
  /** Directory that holds the sharded blob tree. Created on first write. */
  rootDir: string;
}

export interface GcResult {
  removed: number;
  freedBytes: number;
}

const HASH_RE = /^[a-f0-9]{64}$/;

export class BlobStore {
  private readonly rootDir: string;

  constructor(opts: BlobStoreOptions) {
    this.rootDir = opts.rootDir;
  }

  /** Store `content` and return its sha256 hex hash. Idempotent. */
  async put(content: string): Promise<string> {
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    const path = this.pathFor(hash);
    try {
      await stat(path);
      return hash;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await mkdir(this.dirFor(hash), { recursive: true });
    await writeFile(path, content, "utf8");
    return hash;
  }

  /** Return the stored content, or null when absent / malformed hash. */
  async get(hash: string): Promise<string | null> {
    if (!HASH_RE.test(hash)) return null;
    try {
      return await readFile(this.pathFor(hash), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** True iff a blob for `hash` exists on disk. */
  async has(hash: string): Promise<boolean> {
    if (!HASH_RE.test(hash)) return false;
    try {
      await stat(this.pathFor(hash));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  /**
   * Best-effort GC. Walks the store, and if total bytes > maxBytes
   * deletes oldest-first (by mtime) until total <= maxBytes.
   */
  async gc(maxBytes: number): Promise<GcResult> {
    const entries = await this.walk();
    const total = entries.reduce((sum, e) => sum + e.size, 0);
    if (total <= maxBytes) return { removed: 0, freedBytes: 0 };

    // Oldest first.
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let removed = 0;
    let freed = 0;
    let remaining = total;
    for (const entry of entries) {
      if (remaining <= maxBytes) break;
      try {
        await unlink(entry.path);
        removed += 1;
        freed += entry.size;
        remaining -= entry.size;
      } catch {
        // Best-effort — skip on unlink error.
      }
    }
    return { removed, freedBytes: freed };
  }

  private dirFor(hash: string): string {
    return join(this.rootDir, hash.slice(0, 2));
  }

  private pathFor(hash: string): string {
    return join(this.rootDir, hash.slice(0, 2), hash.slice(2));
  }

  private async walk(): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
    let shards: string[];
    try {
      shards = await readdir(this.rootDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
      throw err;
    }
    for (const shard of shards) {
      if (shard.length !== 2) continue;
      const shardDir = join(this.rootDir, shard);
      let files: string[];
      try {
        files = await readdir(shardDir);
      } catch {
        continue;
      }
      for (const file of files) {
        const p = join(shardDir, file);
        try {
          const info = await stat(p);
          if (info.isFile()) {
            out.push({ path: p, size: info.size, mtimeMs: info.mtimeMs });
          }
        } catch {
          // Skip on stat error.
        }
      }
    }
    return out;
  }
}
