/**
 * Cosine similarity, the one survivor of the hybrid-recall module.
 *
 * The BM25 + cosine blend was removed 2026-11-18 (issue #131). Measured at
 * 9.99% vector coverage it could only re-rank ids the keyword search had
 * already found, and on the 12-query bench it never promoted a ground-truth
 * answer: no query pool reached a vectorised row that was the right answer.
 * This function stays because the rewriter gate
 * (`src/memory/retrieve/embedding-gate.ts`) still scores message-to-exemplar
 * similarity with it, which has nothing to do with memory recall.
 */

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: dim mismatch ${a.length} vs ${b.length}`,
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
