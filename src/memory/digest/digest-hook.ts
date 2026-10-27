import type { DigestHook, DigestWorkItem } from "../../agent/agent-loop.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

export const DIGEST_MAX_BODY_CHARS = 2000;

/**
 * Queue #9 — writes the body (distilled work item) to a vault note. Injected
 * so the hook itself never shells out and stays unit-testable.
 */
export interface DigestRunner {
  (args: { title: string; body: string; tags: readonly string[] }): Promise<void>;
}

export interface DigestHookOptions {
  runner: DigestRunner;
  logger?: StructuredLogger;
  /** Config gate `memory.digest.auto`. Off → `recordWorkItem` is a no-op. */
  enabled?: boolean;
  maxBodyChars?: number;
}

/**
 * Queue #9 — default `DigestHook`. Mirrors `lesson-lifecycle-hook`: defensive
 * dedup, per-item try/catch, WARN on failure, never throws into the loop.
 */
export function createDigestHook(opts: DigestHookOptions): DigestHook {
  const { runner, logger } = opts;
  const enabled = opts.enabled ?? true;
  const maxBodyChars = opts.maxBodyChars ?? DIGEST_MAX_BODY_CHARS;
  const seenTitles = new Set<string>();
  return {
    recordWorkItem(item: DigestWorkItem): void {
      if (!enabled) return;
      // Dedup by title: the loop fires once per completed turn, but a
      // misbehaving caller could repeat a title.
      if (seenTitles.has(item.title)) return;
      seenTitles.add(item.title);
      const warn = (err: unknown): void => {
        logger?.warn?.("digest runner failed", {
          sessionId: item.sessionId,
          title: item.title,
          error: err instanceof Error ? err.message : String(err),
        });
      };
      try {
        const body = truncateBody(item.body, maxBodyChars);
        // Sync throw → caught here; async reject → the .catch below. Either
        // way the hook never rethrows, so the next item still runs.
        void runner({ title: item.title, body, tags: [...item.tags] }).catch(warn);
      } catch (err) {
        warn(err);
      }
    },
  };
}

function truncateBody(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}… [truncated ${body.length - maxChars} chars]`;
}
