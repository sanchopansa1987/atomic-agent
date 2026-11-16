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
 * Where to photograph the heap, once. The guard can say a process is heavy but
 * never *what* holds the bytes: measured 2026-11-17, the agent sat at 1143 MB
 * of a 2730 MB ceiling while every stored session together was 65 MB and the
 * largest single text was 240 KB, so storage is not the filler and a cap on it
 * would slow turns for nothing. One snapshot at 1500 MB — well below the 2320 MB
 * abort line, so it costs a live process nothing it was not about to lose —
 * names the real retainer. One per process: a second snapshot on every crossing
 * would write gigabytes for no new answer.
 */
export const HEAP_SNAPSHOT_MB = 1500;

/** True the first time a reading crosses the snapshot line, then never again. */
export function snapshotDue(reading: HeapReading, alreadyTaken: boolean, mb = HEAP_SNAPSHOT_MB): boolean {
  return !alreadyTaken && reading.usedBytes >= mb * 1_048_576;
}

/**
 * The ceiling worth believing: the smaller of what the runtime reports and what
 * this machine can back with RAM. `suggestHeapCeilingMb` is the number
 * `scripts/atomic_chat.sh` passes to `--max-old-space-size`, so on a launcher
 * start the two are equal and this changes nothing there.
 *
 * Measured 2026-10-31: the TUI was healthy at 1432 MB and died at 2730 MB, so
 * 2730 MB *is* this 8 GB box's safe ceiling. A launch that misses
 * `--max-old-space-size` gets Node's ~4 GB default, where 85 % (3.6 GB) is past
 * what the box can flush; believing the smaller number caps that case at the
 * same 2730 MB — abort 2320 MB, warning 2048 MB ahead of it.
 */
export function effectiveLimitBytes(limitBytes: number, totalMemBytes = os.totalmem()): number {
  const budget = suggestHeapCeilingMb(totalMemBytes) * 1_048_576;
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return budget;
  return Math.min(limitBytes, budget);
}

/**
 * Mid-turn trip wire. `classifyHeap` is polled at turn boundaries, and every
 * 2026-10-31 crash happened *inside* one turn — SIGABRT in `Runtime_MapGrow`
 * called from the event-loop check phase, four times in one afternoon. A
 * boundary gate cannot stop that, so this is polled on a timer instead.
 *
 * 2026-11-01: a flat 1800 MB byte wire used to override the ratio and fired at
 * 66 % of the real 2730 MB ceiling, below `HEAP_WARN_RATIO` — an abort with no
 * warning. See `effectiveLimitBytes` for why the ratio alone is the contract.
 */
export function heapNeedsRestart(reading: HeapReading, totalMemBytes = os.totalmem()): boolean {
  const limit = effectiveLimitBytes(reading.limitBytes, totalMemBytes);
  return reading.usedBytes >= HEAP_RESTART_RATIO * limit;
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
export function classifyHeap(reading: HeapReading, totalMemBytes = os.totalmem()): HeapStatus {
  const { usedBytes, limitBytes } = reading;
  // Judge against the same ceiling the trip wire uses, or warn/critical and the
  // abort disagree about what "85 %" means: `heapNeedsRestart` would cap a
  // 4288 MB Node default at this machine's 2730 MB budget while the warning
  // thresholds below still measured against 4288 — so the abort would arrive
  // with no warning ahead of it, the 2026-11-01 defect again.
  const limit = effectiveLimitBytes(limitBytes, totalMemBytes);
  const ratio = usedBytes / limit;
  if (ratio >= HEAP_CRITICAL_RATIO) {
    return {
      severity: "critical",
      usedBytes,
      limitBytes: limit,
      ratio,
      message:
        `memory critical: ${mb(usedBytes)} of ${mb(limit)} usable. ` +
        `The agent may be killed by the runtime without warning — finish or ` +
        `save this turn, then restart with a bigger heap: ` +
        `NODE_OPTIONS=--max-old-space-size=${suggestHeapCeilingMb()}`,
    };
  }
  if (ratio >= HEAP_WARN_RATIO) {
    return {
      severity: "warn",
      usedBytes,
      limitBytes: limit,
      ratio,
      message:
        `memory high: ${mb(usedBytes)} of ${mb(limit)} usable. ` +
        `Long sessions with large file reads can exhaust the default heap; ` +
        `restarting with NODE_OPTIONS=--max-old-space-size=${suggestHeapCeilingMb()} raises it.`,
    };
  }
  return { severity: "ok", usedBytes, limitBytes: limit, ratio, message: null };
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
