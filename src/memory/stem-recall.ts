import { readFileSync, statSync } from "node:fs";
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
export const STEM_MAX_TOKENS = 1900;

/** Order is deliberate: what went wrong, what is open, what was decided. */
const STEM_FILES = ["LESSONS.md", "OPEN.md", "DECISIONS.md"] as const;

/**
 * Per-file budgets, summing under STEM_MAX_TOKENS.
 *
 * Measured 2026-11-17: the three files were 4241 bytes ≈ 1060 tokens against a
 * 900-token cap, so the single shared truncation cut OPEN.md mid-sentence ("#91
 * — daily self-audit red: read data/self_audit/2026-11-") and DECISIONS.md never
 * appeared in the prompt at all. The third spine file was dead wiring: the
 * decisions that define this agent were written every day and shown never.
 * A file may now be shortened, but no file can starve another, and the last
 * line kept is a whole line — a half item reads as a fact that is not there.
 */
const STEM_FILE_BUDGET: Record<(typeof STEM_FILES)[number], number> = {
  "LESSONS.md": 890,
  "OPEN.md": 640,
  "DECISIONS.md": 360,
};

/** Keep whole lines only; a cut item is worse than a shorter list. */
function clampToLines(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (estimateTokens([...kept, line].join("\n")) > maxTokens - 8) break;
    kept.push(line);
  }
  // A single line longer than the whole budget still has to deliver something.
  if (kept.length === 0) return truncateToTokens(text, maxTokens);
  return [...kept, "… (cut at the budget)"].join("\n");
}

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
      if (text.length > 0) parts.push(clampToLines(text, STEM_FILE_BUDGET[file]));
    } catch {
      // A missing spine file is not an error — the block carries what exists.
    }
  }
  if (parts.length === 0) return null;
  return truncateToTokens(parts.join("\n\n"), STEM_MAX_TOKENS);
}

/**
 * A cheap change signal for the stem: the newest mtime of the three spine files,
 * rounded to milliseconds. `identity_spine.py` rewrites the files on every render,
 * so a bump here means the spine changed and the cached block must be re-read.
 * `0` means no spine file exists (matching `recallStemSection` → `null`).
 */
export function stemFileStamp(workingDir: string): number {
  const dir = join(workingDir, "vault", "agent-memory");
  let stamp = 0;
  for (const file of STEM_FILES) {
    try {
      stamp = Math.max(stamp, Math.round(statSync(join(dir, file)).mtimeMs));
    } catch {
      // A missing file contributes nothing.
    }
  }
  return stamp;
}

/** Token estimate for the block budget, exported for the tail/ordering tests. */
export function estimateStemTokens(body: string): number {
  return estimateTokens(body);
}
