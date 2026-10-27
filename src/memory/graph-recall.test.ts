import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GRAPH_MAX_LINES,
  recallGraphSection,
} from "./graph-recall.js";

function fakeScript(body: string, sleepMs = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "graph-recall-"));
  const path = join(dir, "brain_graph.py");
  const lines = ["import time", `print(${JSON.stringify(body)})`];
  if (sleepMs > 0) lines.push(`time.sleep(${sleepMs / 1000})`);
  writeFileSync(path, lines.join("\n"));
  return path;
}

describe("recallGraphSection", () => {
  it("returns the report trimmed to the budget when the script prints hubs + cluster", async () => {
    const path = fakeScript(
      "memories 6 | links 4 | orphans 2\n" +
        "components [4] (largest 4)\n" +
        "hubs: #3(3) note 3, #2(2) note 2\n" +
        "lessons with no incoming link: #1",
    );
    const body = await recallGraphSection(path);
    expect(body).toBeTruthy();
    expect(body).toContain("hubs:");
    expect(body).toContain("note 3");
    expect(body!.split("\n").length).toBeLessThanOrEqual(GRAPH_MAX_LINES);
  });

  it("returns null when the script is missing", async () => {
    expect(await recallGraphSection("/no/such/script.py")).toBeNull();
  });

  it("returns null when the script is slow (past the timeout)", async () => {
    const path = fakeScript("slow", 2000);
    expect(await recallGraphSection(path, 50)).toBeNull();
  });

  it("returns null on empty output", async () => {
    const path = fakeScript("");
    expect(await recallGraphSection(path)).toBeNull();
  });
});
