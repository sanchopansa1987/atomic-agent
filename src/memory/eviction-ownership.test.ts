import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "./memory-store.js";

/**
 * The cap is one number shared by several writers, so it must only spend the runtime's
 * own budget. Stress test 2026-11-17 (400 inserts, cap 50 and cap 10) showed the old
 * predicate `source NOT IN ('vault',...)` eating the 8 trace/session-brief rows within
 * the first evictions: the python writers never bump `recall_count` or
 * `last_recalled_at`, so those rows lose every utility ranking by construction.
 *
 * Pins, each of which failed at least once:
 *   1. a vault note is never evicted, whatever the cap;
 *   2. a row written by another owner (session-brief) is never evicted by this store;
 *   3. the runtime's own rows are capped, and land exactly on the cap.
 */

interface Harness {
  store: MemoryStore;
  dispose: () => void;
}

let harness: Harness;

function seedRaw(store: MemoryStore, source: string, n: number): void {
  const db = store.getDatabaseHandleForEmbeddings();
  const stmt = db.prepare(
    `INSERT INTO memories (content, created_at, updated_at, source, session_id, working_dir, tags)
     VALUES (?,?,?,?,NULL,NULL,NULL)`,
  );
  for (let i = 0; i < n; i++) stmt.run(`${source} row ${i} one two three four`, 1_700_000_000_000 + i, 1_700_000_000_000 + i, source);
}

function countBy(store: MemoryStore, source: string): number {
  const db = store.getDatabaseHandleForEmbeddings();
  return (db.prepare(`SELECT COUNT(*) n FROM memories WHERE source = ?`).get(source) as { n: number }).n;
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "atomic-evict-owner-"));
  harness = {
    store: new MemoryStore({ dbFile: join(dir, "memory.sqlite"), maxEntries: 3, eviction: { utilityWeighted: true } }),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
});

afterEach(() => {
  harness.store.close();
  harness.dispose();
});

describe("eviction ownership", () => {
  it("never evicts a vault note or another writer's rows, and caps its own", () => {
    const { store } = harness;
    seedRaw(store, "vault", 40);
    seedRaw(store, "session-brief", 8);
    const vaultBefore = countBy(store, "vault");
    const briefBefore = countBy(store, "session-brief");

    const now = Date.now();
    for (let i = 0; i < 25; i++) {
      store.store({ content: `agent row ${i} alpha beta gamma delta`, source: i % 2 ? "agent" : "user", tags: [] }, now + i);
    }

    expect(countBy(store, "vault")).toBe(vaultBefore);
    expect(countBy(store, "session-brief")).toBe(briefBefore);
    expect(countBy(store, "agent") + countBy(store, "user")).toBe(3);
  });
});
