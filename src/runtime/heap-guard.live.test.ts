import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The 2026-10-31 crashes were SIGABRTs inside one turn (4 in an afternoon), so
 * a pure-function test cannot prove the trip wire helps: the guard has to win
 * a race against V8's own abort in a real, capped heap. This runs it in one.
 *
 * Child: 128 MB old-space, allocate 2 MB strings until heapNeedsRestart says
 * stop. If the guard works the child prints TRIMMED and exits 0. If it does
 * not, V8 aborts the child (status null, signal SIGABRT) and this fails.
 */
const guardUrl = new URL("./heap-guard.ts", import.meta.url);

const FIXTURE = `
import { heapNeedsRestart, readProcessHeap } from ${JSON.stringify(guardUrl.pathname)};

const sink: string[] = [];
for (let i = 0; i < 400; i += 1) {
  sink.push("x".repeat(2 * 1024 * 1024));
  if (heapNeedsRestart(readProcessHeap())) {
    const used = Math.round(readProcessHeap().usedBytes / 1_048_576);
    console.log("TRIMMED " + used);
    process.exit(0);
  }
}
console.log("NEVER_TRIMMED");
`;

describe("heap guard against a real V8 abort", () => {
  it("trips inside a 128 MB heap before the runtime aborts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "heap-guard-live-"));
    const fixture = path.join(dir, "burn.ts");
    writeFileSync(fixture, FIXTURE);
    try {
      const res = spawnSync(
        process.execPath,
        ["--max-old-space-size=128", "--import", "tsx", fixture],
        { encoding: "utf8", timeout: 120_000, cwd: process.cwd() },
      );
      const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      expect(output).toContain("TRIMMED");
      expect(res.signal).toBeNull();
      expect(res.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
