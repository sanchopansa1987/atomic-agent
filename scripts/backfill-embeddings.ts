/**
 * One-off: embed the existing memory corpus.
 *
 * Nothing in the runtime backfills `memory_embeddings` — `bootstrap.ts:1346`
 * only attaches the writer, and rows are written incrementally on `store()`.
 * So the 173-row corpus stays vector-less (hybrid recall silently degenerates
 * to FTS5) until every row is rewritten. This fills the gap once.
 *
 * Idempotent: `EmbeddingStore.upsert` is ON CONFLICT (memory_id, model).
 * Read-only w.r.t. `memories`; only `memory_embeddings` is written.
 *
 * Usage: node --import tsx scripts/backfill-embeddings.ts [--dry]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { LlamaEmbeddingClient } from "../src/memory/embeddings/embedding-client.js";
import { EmbeddingStore } from "../src/memory/embeddings/embedding-store.js";
import {
  getEmbeddingModelDef,
  isKnownEmbeddingModelId,
} from "../src/local-llm/models-catalog.js";

const DRY = process.argv.includes("--dry");
const cfg = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".atomic-agent/config.json"), "utf8"),
);
const modelId = cfg.localModels.embeddings.modelId;
if (!cfg.memory.embeddings.enabled || !cfg.localModels.embeddings.enabled) {
  throw new Error("embeddings are not enabled in config; refusing to backfill");
}
if (modelId === null || !isKnownEmbeddingModelId(modelId)) {
  throw new Error(`unknown embedding model id: ${String(modelId)}`);
}

const def = getEmbeddingModelDef(modelId);
const db = new Database(path.join(os.homedir(), ".atomic-agent/memory.sqlite"));
db.pragma("foreign_keys = ON");
const store = new EmbeddingStore({ db });
const client = new LlamaEmbeddingClient({
  url: cfg.localModels.embeddings.url,
  dim: def.dim,
  model: def.id,
});

const rows = db.prepare("SELECT id, content FROM memories ORDER BY id").all() as Array<{
  id: number;
  content: string;
}>;

let written = 0;
const failures: Array<{ id: number; error: string }> = [];
const t0 = Date.now();

for (const row of rows) {
  try {
    const { vector } = await client.embed({ text: row.content });
    if (vector.length !== def.dim) throw new Error(`dim ${vector.length} != ${def.dim}`);
    if (!DRY) {
      store.upsert({
        memoryId: row.id,
        model: def.id,
        dim: def.dim,
        vector,
        createdAt: Date.now(),
      });
    }
    written += 1;
    if (written % 25 === 0) process.stdout.write(`  ${written}/${rows.length}\n`);
  } catch (err) {
    failures.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
  }
}

console.log(
  JSON.stringify(
    {
      dryRun: DRY,
      corpus: rows.length,
      written,
      failed: failures.length,
      failures: failures.slice(0, 5),
      model: def.id,
      dim: def.dim,
      seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
      rowsInTable: store.countByModel(def.id),
    },
    null,
    2,
  ),
);
db.close();
