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

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

  /** Synchronous counterpart for legacy session reads; publish only complete files. */
  putSync(content: string): string {
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    const path = this.pathFor(hash);
    try {
      if (readFileSync(path, "utf8") === content) return hash;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    mkdirSync(this.dirFor(hash), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
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
   * Resolve a hash prefix (8..64 hex chars) to the one blob it names.
   *
   * `tool.recall` kept being handed a truncated pointer, and demanding all 64
   * characters turned a recoverable result into a dead end — the reader could
   * see `[truncated]` and still not reach the body. A prefix names one blob;
   * only ambiguity is worth refusing, and it says so.
   */
  async resolvePrefix(prefix: string): Promise<string | null> {
    const p = prefix.trim().toLowerCase();
    if (!/^[a-f0-9]{8,64}$/.test(p)) return null;
    if (p.length === 64) return (await this.has(p)) ? p : null;
    const shard = p.slice(0, 2);
    let files: string[];
    try {
      files = await readdir(join(this.rootDir, shard));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const matches = files.filter(
      (file) => /^[a-f0-9]{62}$/.test(file) && `${shard}${file}`.startsWith(p),
    );
    if (matches.length === 1) return `${shard}${matches[0]}`;
    if (matches.length > 1) {
      throw new Error(
        `blob prefix "${prefix}" is ambiguous (${matches.length} stored outputs match); pass more characters`,
      );
    }
    return null;
  }

  /**
   * Best-effort GC. Removes blobs older than maxAgeMs (if supplied), then
   * if total bytes > maxBytes deletes oldest-first (by mtime) until total <= maxBytes.
   */
  async gc(maxBytes: number, maxAgeMs?: number): Promise<GcResult> {
    const entries = await this.walk();
    let removed = 0;
    let freed = 0;

    // Oldest first: expire aged blobs even when the store is under budget.
    const cutoff = maxAgeMs === undefined ? -Infinity : Date.now() - maxAgeMs;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let remaining = entries.reduce((sum, e) => sum + e.size, 0);
    for (const entry of entries) {
      if (entry.mtimeMs >= cutoff && remaining <= maxBytes) break;
      try {
        await unlink(entry.path);
        removed += 1;
        freed += entry.size;
        remaining -= entry.size;
      } catch {
        // Best-effort: failed deletions still count against the byte budget.
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
