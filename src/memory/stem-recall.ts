import { readFileSync } from "node:fs";
import { join } from "node:path";

import { estimateTokens, truncateToTokens } from "../prompt/token-budget.js";

/**
 * The `### stem` block: the identity spine, always in the prompt.
 *
 * Measured 2026-11-17: the three spine files total 4586 bytes and **no source file
 * in this repo read them**, so the lessons, open work and decisions that define this
 * agent reached it only if someone asked. Meanwhile 3689 of a 4600-token pin budget
 * was spent on facts no command can check, and the graph's six most-linked notes were
 * a chat fragment, two trade losses, a three-week-old failure list and a broken dump.
 *
 * The block is fixed and cheap on purpose: a small, always-present core written by a
 * generator (`scripts/identity_spine.py`), not by history. Everything noisy stays in
 * retrieval, where being linked earns attention only when a query asks for it.
 */
export const STEM_MAX_TOKENS = 900;

/** Order is deliberate: what went wrong, what is open, what was decided. */
const STEM_FILES = ["LESSONS.md", "OPEN.md", "DECISIONS.md"] as const;

/**
 * Read `<workingDir>/vault/agent-memory/{LESSONS,OPEN,DECISIONS}.md` and return the
 * block body, or `null` when none exists. Never throws: a missing or unreadable
 * spine degrades to "no block", like a failed graph read.
 */
export function recallStemSection(workingDir: string): string | null {
  const dir = join(workingDir, "vault", "agent-memory");
  const parts: string[] = [];
  for (const file of STEM_FILES) {
    try {
      const text = readFileSync(join(dir, file), "utf8").trim();
      if (text.length > 0) parts.push(text);
    } catch {
      // A missing spine file is not an error — the block carries what exists.
    }
  }
  if (parts.length === 0) return null;
  return truncateToTokens(parts.join("\n\n"), STEM_MAX_TOKENS);
}

/** Token estimate for the block budget, exported for the tail/ordering tests. */
export function estimateStemTokens(body: string): number {
  return estimateTokens(body);
}
