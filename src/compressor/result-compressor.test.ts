import { describe, it, expect } from "vitest";
import {
  RAW_TOOL_OUTPUT,
  TOOL_RESULT_KEEP_PATTERN,
  compressToolResult,
} from "./result-compressor.js";
import { summariseLog } from "./log-summarizer.js";

describe("compressToolResult", () => {
  it("keeps short output unchanged except formatting", () => {
    const out = compressToolResult({
      tool: "read_file",
      status: "ok",
      output: "hello",
    });
    expect(out.summary).toContain("hello");
    expect(out.truncated).toBe(false);
  });

  it("never elides a small output, and keeps every elided body recoverable", () => {
    const small = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const kept = compressToolResult({ tool: "os.fs.edit", status: "ok", output: small });
    expect(kept.summary).toContain("line 0");
    expect(kept.summary).not.toContain("elided");
    expect(kept.truncated).toBe(false);

    const big = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const cut = compressToolResult({ tool: "os.fs.edit", status: "ok", output: big });
    expect(cut.truncated).toBe(true);
    // The dropped middle must be recoverable via the blob store, not just marked.
    expect(cut[RAW_TOOL_OUTPUT]).toBe(big);
  });


  it("trims long output to the configured tail and marks truncation", () => {
    const longOutput = Array.from({ length: 400 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const out = compressToolResult(
      { tool: "run_test", status: "ok", output: longOutput },
      { maxSummaryLength: 200, maxTailLines: 4 },
    );
    expect(out.summary.length).toBeLessThanOrEqual(210);
    expect(out.summary).toContain("lines omitted");
    expect(out.truncated).toBe(true);
  });

  it("extracts the first error signature when status is error", () => {
    const log = [
      "running tests ...",
      "collected 3 items",
      "test_auth.py::test_refresh FAILED",
      "E   AssertionError: session None after refresh",
      "====== 1 failed, 2 passed in 0.12s ======",
    ].join("\n");
    const out = compressToolResult({
      tool: "run_test",
      status: "error",
      output: log,
    });
    expect(out.summary).toMatch(/key:/);
    expect(out.summary).toContain("AssertionError");
  });

  it("retains failure lines outside the tail and stays under budget (keepPattern)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 400; i += 1) lines.push(`  ok line ${i}`);
    const critical = [
      "FAIL suite/a.test.ts",
      "  AssertionError: boom",
      "  Expected 1 Received 2",
    ];
    // Put the failures in the middle, well outside the 40-line tail.
    lines.splice(80, 0, ...critical);
    const raw = lines.join("\n");
    const out = compressToolResult(
      { tool: "run_test", status: "error", output: raw },
      {
        maxSummaryLength: 3000,
        maxTailLines: 40,
        keepPattern: TOOL_RESULT_KEEP_PATTERN,
      },
    );
    for (const c of critical) expect(out.summary).toContain(c);
    expect(out.summary).toContain("elided");
    expect(out.summary.length).toBeLessThanOrEqual(raw.length * 0.6);
  });

  it("leaves a short result byte-identical (no marker, no truncation)", () => {
    const raw = "a.py:1: ok\nb.py:2: ok";
    const out = compressToolResult(
      { tool: "os.fs.grep", status: "ok", output: raw },
      {
        maxSummaryLength: 8000,
        maxTailLines: 40,
        keepPattern: TOOL_RESULT_KEEP_PATTERN,
      },
    );
    expect(out.summary).toBe(raw);
    expect(out.truncated).toBe(false);
  });

  it("passes output through whole when it fits the char budget (no elision by line count alone)", () => {
    // 80 non-blank lines, ~5.6 KB — taller than maxTailLines but far inside the
    // 16 000-char render cap. This used to be sliced to 40 lines anyway, so a
    // `sed`/`docker inspect` dump lost the rows it was run for.
    const raw = Array.from({ length: 80 }, (_, i) => `line ${i} ${"y".repeat(60)}`).join("\n");
    const out = compressToolResult(
      { tool: "os.shell.run", status: "ok", output: raw },
      { maxSummaryLength: 16_000, maxTailLines: 40, keepPattern: TOOL_RESULT_KEEP_PATTERN },
    );
    expect(out.summary).toBe(raw);
    expect(out.truncated).toBe(false);
    expect(out.summary).not.toContain("elided");
  });

  it("keeps section headers from the middle, in place, on a multi-section result", () => {
    // 12 sections x 40 lines: every header sits far above any tail slice.
    const lines: string[] = [];
    for (let section = 0; section < 12; section += 1) {
      lines.push(`== section ${section} ==`);
      for (let i = 0; i < 40; i += 1) lines.push(`  item ${section}-${i}`);
    }
    lines.push("exit: 0");
    const out = compressToolResult(
      { tool: "os.shell.run", status: "ok", output: lines.join("\n") },
      { maxSummaryLength: 3000, maxTailLines: 40 },
    );
    for (let section = 0; section < 12; section += 1) {
      expect(out.summary).toContain(`== section ${section} ==`);
    }
    // Original order is preserved: the header precedes its own items, and the
    // newest line is last (the old hoist put kept lines above the tail).
    expect(out.summary.indexOf("== section 0 ==")).toBeLessThan(
      out.summary.indexOf("== section 1 =="),
    );
    expect(out.summary.trimEnd().endsWith("exit: 0")).toBe(true);
    expect(out.summary).toContain("lines omitted");
    expect(out.summary).toContain("item 11-39");
    expect(out.summary).not.toContain("item 5-0");
  });

  it("char backstop keeps both ends instead of dropping the newest lines", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(60)}`);
    const out = compressToolResult(
      { tool: "os.shell.run", status: "ok", output: lines.join("\n") },
      { maxSummaryLength: 2000, maxTailLines: 300 },
    );
    expect(out.summary.length).toBeLessThanOrEqual(2050);
    expect(out.summary).toContain("chars elided");
    expect(out.summary).toContain("line 0 ");
    expect(out.summary).toContain("line 299 ");
  });

  it("a budget too small for head + marker still returns a capped string", () => {
    // slice(-0) is the whole string: before the guard, a tiny budget returned
    // the full 5000-char body uncapped.
    const out = compressToolResult(
      { tool: "os.shell.run", status: "ok", output: "y".repeat(5000) },
      { maxSummaryLength: 40, maxTailLines: 5000 },
    );
    expect(out.summary.length).toBeLessThanOrEqual(40);
    expect(out.summary).toContain("chars elided");
  });
});

describe("summariseLog", () => {
  it("counts errors, warnings, passes and failures", () => {
    const log = [
      "PASS suite/a.test.ts",
      "FAIL suite/b.test.ts",
      "  Error: boom",
      "  warn: flaky",
      "PASS suite/c.test.ts",
    ].join("\n");
    const summary = summariseLog(log);
    expect(summary.passCount).toBeGreaterThanOrEqual(2);
    expect(summary.failCount).toBeGreaterThanOrEqual(1);
    expect(summary.errorLines).toBeGreaterThanOrEqual(1);
    expect(summary.warningLines).toBeGreaterThanOrEqual(1);
    expect(summary.firstFailure).toMatch(/FAIL suite\/b/);
  });
});
