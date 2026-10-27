import { execFileSync } from "node:child_process";
import type { DigestRunner } from "./digest-hook.js";

/**
 * Queue #9 — default digest runner. Shells out to `scripts/brain.py digest`
 * with the body on stdin (brain.py's `cmd_digest` reads `sys.stdin` when
 * `--body-file` is absent), cwd pinned to the repo root so the relative
 * `scripts/brain.py` path resolves. `brain.py` writes
 * `vault/agent-memory/<date>_<slug>.md` and re-indexes.
 */
export function createDefaultDigestRunner(cwd: string): DigestRunner {
  return async ({ title, body, tags }) => {
    execFileSync(
      "python3",
      ["scripts/brain.py", "digest", "--title", title, "--tags", tags.join(",")],
      { cwd, input: body, encoding: "utf8" },
    );
  };
}
