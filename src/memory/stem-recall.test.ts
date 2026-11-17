import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { STEM_MAX_TOKENS, estimateStemTokens, recallStemSection } from "./stem-recall.js";

const roots: string[] = [];

function spineRoot(lessons: number, open: number): string {
  const root = mkdtempSync(join(tmpdir(), "stem-"));
  roots.push(root);
  const dir = join(root, "vault", "agent-memory");
  mkdirSync(dir, { recursive: true });
  const header = "---\ntype: spine\ndate: 2026-11-17\n---\n\n";
  writeFileSync(
    join(dir, "LESSONS.md"),
    header + Array.from({ length: lessons }, (_, i) =>
      `- **lesson ${i}** — ${"L".repeat(120)}`).join("\n"),
  );
  writeFileSync(
    join(dir, "OPEN.md"),
    header + "# Open work\n\n" + Array.from({ length: open }, (_, i) =>
      `- #${i} — open item ${i} ${"O".repeat(90)}`).join("\n"),
  );
  writeFileSync(
    join(dir, "DECISIONS.md"),
    header + "# Decided\n\n- decision one — outcome: kept and verified\n",
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("recallStemSection", () => {
  it("returns null when no spine exists", () => {
    const root = mkdtempSync(join(tmpdir(), "stem-empty-"));
    roots.push(root);
    expect(recallStemSection(root)).toBeNull();
  });

  // Measured 2026-11-17: 14 lessons + 14 open items totalled ~1060 tokens, the
  // single shared truncation ate DECISIONS.md whole, so the section that says
  // what this agent decided never reached its own prompt.
  it("keeps DECISIONS.md in the block when the other two overflow", () => {
    const body = recallStemSection(spineRoot(14, 14));
    expect(body).not.toBeNull();
    expect(body).toContain("Decided");
    expect(body).toContain("decision one");
    expect(estimateStemTokens(body!)).toBeLessThanOrEqual(STEM_MAX_TOKENS);
  });

  it("never ends a section with half an item", () => {
    const body = recallStemSection(spineRoot(14, 14))!;
    const openItems = body.split("\n").filter((line) => /^- #\d+ — open item/.test(line));
    expect(openItems.length).toBeGreaterThan(0);
    for (const line of openItems) {
      expect(line.endsWith("O") || line.endsWith("(cut at the budget)")).toBe(true);
    }
    expect(body).not.toContain("[truncated]");
  });
});
