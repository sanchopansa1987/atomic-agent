import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  getEmbeddingModelDef,
  isKnownEmbeddingModelId,
} from "../src/local-llm/models-catalog.js";
import {
  resolveModelFilePath,
  resolveEmbeddingPidFilePath,
} from "../src/local-llm/backend-paths.js";
import { readRunningPid } from "../src/local-llm/daemon-lifecycle.js";

const DATA_DIR = path.join(os.homedir(), ".atomic-agent");
const MODEL_ID = "nomic-embed-text-v1.5" as const;
const OLLAMA_GGUF =
  "/Users/kst/.ollama/models/blobs/sha256-970aa74c0a90ef7482477cf803618e776e173c007bf957f635f1015bfcfef0e6";

const def = getEmbeddingModelDef(MODEL_ID);
const dest = resolveModelFilePath(DATA_DIR, MODEL_ID, def.filename);
fs.mkdirSync(path.dirname(dest), { recursive: true });
if (!fs.existsSync(dest)) fs.symlinkSync(OLLAMA_GGUF, dest);

const shimPid = Number(
  execSync("pgrep -f 'embedding-shim.py' | head -1", { encoding: "utf8" }).trim(),
);
const pidPath = resolveEmbeddingPidFilePath(DATA_DIR);
fs.writeFileSync(pidPath, `${shimPid}\n`);

// Replicate reconcileHybridRecallFromDaemon()'s two inputs exactly.
const hasModel =
  isKnownEmbeddingModelId(MODEL_ID) && fs.existsSync(dest);
const running = readRunningPid(DATA_DIR, "embedding");

console.log({
  modelFile: dest,
  filename: def.filename,
  hasModel,
  pidPath,
  pidWritten: shimPid,
  readRunningPid: running,
  shouldEnable: hasModel && running !== null,
});
