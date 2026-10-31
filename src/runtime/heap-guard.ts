import os from "node:os";
import v8 from "node:v8";

/**
 * Heap headroom watchdog.
 *
 * Issue #121: a long session died with `FATAL ERROR: Ineffective
 * mark-compacts near heap limit` at 4083 MB — Node's *default* ceiling
 * (~4288 MB), because the SEA build sets no `--max-old-space-size`. The
 * process vanished with no warning and took ~40 minutes of work with it.
 *
 * V8 cannot raise its own ceiling after startup (`setFlagsFromString`
 * is a no-op for `--max-old-space-size` once the heap exists), so this
 * cannot prevent the crash. What it can do is make the crash *legible*:
 * warn while there is still headroom to save work and restart with a
 * bigger ceiling.
 *
 * Pure except for the injected `readHeap`, so the thresholds are unit
 * testable without allocating gigabytes.
 */

export interface HeapReading {
  usedBytes: number;
  limitBytes: number;
}

export type HeapSeverity = "ok" | "warn" | "critical";

export interface HeapStatus {
  severity: HeapSeverity;
  usedBytes: number;
  limitBytes: number;
  /** Fraction of the ceiling in use, 0..1. */
  ratio: number;
  /** Operator-facing line; `null` while `ok`. */
  message: string | null;
}

/** Fraction of the heap ceiling at which we start warning. */
export const HEAP_WARN_RATIO = 0.75;
/** Fraction at which a crash is imminent and the wording escalates. */
export const HEAP_CRITICAL_RATIO = 0.9;

/**
 * Fraction at which the running turn is aborted for a re-exec. Below
 * critical on purpose: 0.85 of a 2 730 MB ceiling leaves ~410 MB to flush
 * the turn and hand the TTY to the child — the difference between a restart
 * and a SIGABRT.
 */
export const HEAP_RESTART_RATIO = 0.85;

/**
 * Hard byte ceiling, independent of the reported limit. `NODE_OPTIONS` sets
 * `--max-old-space-size` in `~/.zshrc`, which a launch that does not source
 * zsh (IDE task, cron, a GUI double-click, `env -i`) never gets: the ceiling
 * then defaults to ~4 GB, 85 % of it is 3.4 GB, and an 8 GB box swaps to death
 * *before* the ratio trips. This is the last line: measured 2026-10-31, the
 * TUI was healthy at 1432 MB and died at 2730 MB, so 1800 MB is the latest
 * point that still leaves room to flush a turn.
 */
export const HEAP_RESTART_ABS_BYTES = 1800 * 1_048_576;

/**
 * Mid-turn trip wire. `classifyHeap` is polled at turn boundaries, and every
 * 2026-10-31 crash happened *inside* one turn — SIGABRT in `Runtime_MapGrow`
 * called from the event-loop check phase, four times in one afternoon. A
 * boundary gate cannot stop that, so this is polled on a timer instead.
 */
export function heapNeedsRestart(reading: HeapReading): boolean {
  if (reading.usedBytes >= HEAP_RESTART_ABS_BYTES) return true;
  if (!Number.isFinite(reading.limitBytes) || reading.limitBytes <= 0) return false;
  return reading.usedBytes / reading.limitBytes >= HEAP_RESTART_RATIO;
}

/**
 * The ceiling to suggest when advising a restart: a third of physical RAM,
 * clamped to 2048..4096 MB. The old advice was a hardcoded 8192 MB, which is
 * most of an 8 GB box — following it swaps the machine instead of saving it.
 * `scripts/atomic_chat.sh` computes the same number, so the advice matches
 * what the launcher will actually do.
 */
export function suggestHeapCeilingMb(totalMemBytes = os.totalmem()): number {
  const third = Math.floor(totalMemBytes / 3 / 1_048_576);
  return Math.min(4096, Math.max(2048, third));
}

export function readProcessHeap(): HeapReading {
  const s = v8.getHeapStatistics();
  return { usedBytes: s.used_heap_size, limitBytes: s.heap_size_limit };
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1_048_576)} MB`;
}

/**
 * Classify one heap reading. `limitBytes <= 0` (a runtime that does not
 * report a ceiling) is treated as "ok" rather than dividing by zero.
 */
export function classifyHeap(reading: HeapReading): HeapStatus {
  const { usedBytes, limitBytes } = reading;
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
    return { severity: "ok", usedBytes, limitBytes, ratio: 0, message: null };
  }
  const ratio = usedBytes / limitBytes;
  if (ratio >= HEAP_CRITICAL_RATIO) {
    return {
      severity: "critical",
      usedBytes,
      limitBytes,
      ratio,
      message:
        `memory critical: ${mb(usedBytes)} of ${mb(limitBytes)} used. ` +
        `The agent may be killed by the runtime without warning — finish or ` +
        `save this turn, then restart with a bigger heap: ` +
        `NODE_OPTIONS=--max-old-space-size=${suggestHeapCeilingMb()}`,
    };
  }
  if (ratio >= HEAP_WARN_RATIO) {
    return {
      severity: "warn",
      usedBytes,
      limitBytes,
      ratio,
      message:
        `memory high: ${mb(usedBytes)} of ${mb(limitBytes)} used. ` +
        `Long sessions with large file reads can exhaust the default heap; ` +
        `restarting with NODE_OPTIONS=--max-old-space-size=${suggestHeapCeilingMb()} raises it.`,
    };
  }
  return { severity: "ok", usedBytes, limitBytes, ratio, message: null };
}

/**
 * Stateful wrapper that reports only when severity *rises*, so a session
 * sitting at 76% does not repeat the same line on every poll. Dropping
 * back below a threshold re-arms it.
 */
export function createHeapGuard(
  readHeap: () => HeapReading = readProcessHeap,
): { check: () => HeapStatus | null } {
  const rank: Record<HeapSeverity, number> = { ok: 0, warn: 1, critical: 2 };
  let reported: HeapSeverity = "ok";
  return {
    check(): HeapStatus | null {
      const status = classifyHeap(readHeap());
      if (rank[status.severity] > rank[reported]) {
        reported = status.severity;
        return status;
      }
      if (rank[status.severity] < rank[reported]) reported = status.severity;
      return null;
    },
  };
}
