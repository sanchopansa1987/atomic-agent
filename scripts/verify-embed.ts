import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LlamaEmbeddingClient } from "/Users/kst/Desktop/trading_bot/atomic-agent/src/memory/embeddings/embedding-client.js";
import {
  getEmbeddingModelDef,
  isKnownEmbeddingModelId,
} from "/Users/kst/Desktop/trading_bot/atomic-agent/src/local-llm/models-catalog.js";

const cfg = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".atomic-agent/config.json"), "utf8"),
);
const e = cfg.localModels.embeddings;
const known = e.modelId !== null && isKnownEmbeddingModelId(e.modelId);
console.log("bootstrap gates:", {
  memoryEmbeddings: cfg.memory.embeddings.enabled,
  localEmbeddings: e.enabled,
  modelId: e.modelId,
  knownId: known,
  url: e.url,
});
if (!(cfg.memory.embeddings.enabled && e.enabled && known)) {
  console.log("GATE FAILED — bootstrap would degrade to FTS5");
  process.exit(1);
}

const def = getEmbeddingModelDef(e.modelId as Parameters<typeof getEmbeddingModelDef>[0]);
const health = await fetch(`${e.url}/health`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.status)
  .catch((err) => String(err));
console.log("probe /health:", health, "| catalog dim:", def.dim, "| catalog id:", def.id);

const client = new LlamaEmbeddingClient({ url: e.url, dim: def.dim, model: def.id });
const res = await client.embed({ text: "funding arbitrage falsified across two universes" });
console.log("embed:", res.vector.length, "floats | model:", res.model, "| head:", Array.from(res.vector.slice(0, 3)));
