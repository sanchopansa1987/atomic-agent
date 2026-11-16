import { describe, it, expect } from "vitest";
import {
  classifyHeap,
  createHeapGuard,
  readProcessHeap,
  suggestHeapCeilingMb,
  effectiveLimitBytes,
  snapshotDue,
  HEAP_SNAPSHOT_MB,
  HEAP_WARN_RATIO,
  HEAP_CRITICAL_RATIO,
  HEAP_RESTART_RATIO,
  heapNeedsRestart,
  type HeapReading,
} from "./heap-guard.js";

const GB = 1_073_741_824;
const MB = 1_048_576;
/**
 * Pinned machine: 8 GB of RAM, so `suggestHeapCeilingMb` budgets 2730 MB.
 * Every ratio assertion below passes this explicitly — the guard reads
 * `os.totalmem()` by default, and an unpinned test would pass on this box and
 * lie on a 64 GB one.
 */
const MEM8 = 8 * GB;
const BUDGET = 2730 * MB;
const reading = (usedGb: number, limitGb = 4): HeapReading => ({
  usedBytes: usedGb * GB,
  limitBytes: limitGb * GB,
});

describe("effectiveLimitBytes", () => {
  it("keeps a ceiling the machine can actually back", () => {
    expect(effectiveLimitBytes(2730 * MB, MEM8)).toBe(BUDGET);
  });

  it("caps Node's ~4 GB default at this box's budget", () => {
    // 85 % of 4288 MB is 3645 MB; an 8 GB box cannot flush that.
    expect(effectiveLimitBytes(4288 * MB, MEM8)).toBe(BUDGET);
  });

  it("follows a ceiling below the budget", () => {
    expect(effectiveLimitBytes(1024 * MB, MEM8)).toBe(1024 * MB);
  });

  it("falls back to the budget when the runtime reports no ceiling", () => {
    expect(effectiveLimitBytes(0, MEM8)).toBe(BUDGET);
    expect(effectiveLimitBytes(Number.NaN, MEM8)).toBe(BUDGET);
  });
});

describe("classifyHeap", () => {
  it("stays quiet with headroom", () => {
    const s = classifyHeap(reading(1), MEM8);
    expect(s.severity).toBe("ok");
    expect(s.message).toBeNull();
  });

  it("warns at the warn ratio and names the remedy", () => {
    const s = classifyHeap(reading(1.5, 2), MEM8);
    expect(s.severity).toBe("warn");
    expect(s.message).toContain("max-old-space-size");
  });

  it("escalates at the critical ratio", () => {
    const s = classifyHeap(reading(2 * HEAP_CRITICAL_RATIO, 2), MEM8);
    expect(s.severity).toBe("critical");
    expect(s.message).toMatch(/critical/);
  });

  it("reports the real numbers in MB, against the ceiling it believes", () => {
    // The reported #121 crash: 4083 MB used against a ~4288 MB ceiling. On this
    // box the believed ceiling is 2730 MB, and the message must say so rather
    // than repeat a number the machine cannot back.
    const s = classifyHeap({ usedBytes: 4083 * MB, limitBytes: 4288 * MB }, MEM8);
    expect(s.severity).toBe("critical");
    expect(s.message).toContain("4083 MB");
    expect(s.message).toContain("2730 MB");
    expect(s.limitBytes).toBe(BUDGET);
  });

  it("escalates instead of dividing by zero when no ceiling is reported", () => {
    // 2026-11-01: this used to return "ok" with ratio 0 — a silent pass on a
    // runtime that reported nothing, which is the one case with no other signal.
    const s = classifyHeap({ usedBytes: 5 * GB, limitBytes: 0 }, MEM8);
    expect(s.severity).toBe("critical");
    expect(s.message).toContain("2730 MB");
  });
});

describe("heapNeedsRestart", () => {
  it("stays false below the restart ratio on a small ceiling", () => {
    expect(heapNeedsRestart(reading(1 * HEAP_RESTART_RATIO - 0.01, 1), MEM8)).toBe(false);
  });

  it("trips at the restart ratio, before critical", () => {
    expect(heapNeedsRestart(reading(1 * HEAP_RESTART_RATIO, 1), MEM8)).toBe(true);
    expect(HEAP_RESTART_RATIO).toBeLessThan(HEAP_CRITICAL_RATIO);
  });

  it("trips on the real 2026-10-31 numbers (2730 MB ceiling)", () => {
    expect(heapNeedsRestart({ usedBytes: 2400 * MB, limitBytes: BUDGET }, MEM8)).toBe(true);
    expect(heapNeedsRestart({ usedBytes: 718 * MB, limitBytes: BUDGET }, MEM8)).toBe(false);
  });

  it("trips on the budget when the runtime reports no ceiling", () => {
    // A launch that never sourced zsh gets no --max-old-space-size at all.
    expect(heapNeedsRestart({ usedBytes: 5 * GB, limitBytes: 0 }, MEM8)).toBe(true);
    expect(heapNeedsRestart({ usedBytes: 1 * GB, limitBytes: 0 }, MEM8)).toBe(false);
  });

  it("caps an unsafe default ceiling at the budget (Node's ~4 GB)", () => {
    // 2400 MB is 56 % of 4288 — the old ratio would wait until 3645 MB. Capped
    // at 2730, 2320 MB trips instead.
    expect(heapNeedsRestart({ usedBytes: 2400 * MB, limitBytes: 4 * GB }, MEM8)).toBe(true);
    expect(heapNeedsRestart({ usedBytes: 2048 * MB, limitBytes: 4 * GB }, MEM8)).toBe(false);
  });

  it("does not trip the byte wire below the warn line (2026-11-01 report)", () => {
    // The launcher's real 2730 MB ceiling: an unconditional 1800 MB wire fired
    // at 66 %, *below* HEAP_WARN_RATIO, aborting a turn while the operator's bar
    // read "nowhere near the critical line". Ratio only: 0.85 * 2730 = 2320 MB.
    expect(heapNeedsRestart({ usedBytes: 1800 * MB, limitBytes: BUDGET }, MEM8)).toBe(false);
    expect(heapNeedsRestart({ usedBytes: 2048 * MB, limitBytes: BUDGET }, MEM8)).toBe(false);
    expect(heapNeedsRestart({ usedBytes: 2340 * MB, limitBytes: BUDGET }, MEM8)).toBe(true);
  });

  it("can never trip before a warning is possible, whatever the ceiling", () => {
    for (const limitBytes of [512 * MB, BUDGET, 4288 * MB, 0]) {
      const justUnderWarn = HEAP_WARN_RATIO * effectiveLimitBytes(limitBytes, MEM8) - 1;
      expect(heapNeedsRestart({ usedBytes: justUnderWarn, limitBytes }, MEM8)).toBe(false);
    }
  });
});

describe("createHeapGuard", () => {
  it("reports each escalation once, not on every poll", () => {
    let used = 1;
    const guard = createHeapGuard(() => reading(used));
    expect(guard.check()).toBeNull(); // ok
    used = 2.1; // 78 % of the 2730 MB budget -> warn
    expect(guard.check()?.severity).toBe("warn");
    expect(guard.check()).toBeNull(); // still warn, stay quiet
    expect(guard.check()).toBeNull();
    used = 2.6; // 95 % -> critical
    expect(guard.check()?.severity).toBe("critical");
    expect(guard.check()).toBeNull();
  });

  it("re-arms after memory is released", () => {
    let used = 2.1;
    const guard = createHeapGuard(() => reading(used));
    expect(guard.check()?.severity).toBe("warn");
    used = 1; // recovered
    expect(guard.check()).toBeNull();
    used = 2.1; // climbs again -> warn again
    expect(guard.check()?.severity).toBe("warn");
  });
});

describe("suggestHeapCeilingMb", () => {
  it("suggests a third of RAM on this 8 GB box, not 8192", () => {
    expect(suggestHeapCeilingMb(8 * GB)).toBe(2730);
  });

  it("clamps a big host at 4096 and a small host at 2048", () => {
    expect(suggestHeapCeilingMb(64 * GB)).toBe(4096);
    expect(suggestHeapCeilingMb(4 * GB)).toBe(2048);
  });

  it("puts the suggestion in the crash advice", () => {
    const s = classifyHeap({ usedBytes: 2700 * MB, limitBytes: 4288 * MB }, MEM8);
    expect(s.message).toContain(`max-old-space-size=${suggestHeapCeilingMb()}`);
  });
});

describe("readProcessHeap", () => {
  it("reads a real, sane ceiling from this process", () => {
    const r = readProcessHeap();
    expect(r.limitBytes).toBeGreaterThan(0);
    expect(r.usedBytes).toBeGreaterThan(0);
    expect(r.usedBytes).toBeLessThan(r.limitBytes);
  });
});

describe("snapshotDue", () => {
  it("fires at the line, not before", () => {
    expect(snapshotDue({ usedBytes: 1499 * MB, limitBytes: 2730 * MB }, false)).toBe(false);
    expect(snapshotDue({ usedBytes: 1500 * MB, limitBytes: 2730 * MB }, false)).toBe(true);
  });

  it("fires once per process", () => {
    expect(snapshotDue({ usedBytes: 2000 * MB, limitBytes: 2730 * MB }, true)).toBe(false);
  });

  it("leaves room before the abort line", () => {
    // A snapshot must cost nothing the process was not about to lose.
    expect(HEAP_SNAPSHOT_MB).toBeLessThan(suggestHeapCeilingMb(MEM8) * HEAP_RESTART_RATIO);
  });
});
