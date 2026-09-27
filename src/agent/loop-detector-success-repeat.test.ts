import { describe, expect, it } from "vitest";
import { ToolLoopTracker } from "./loop-detector.js";

describe("successful repeated observations", () => {
  it("breaks after six identical shell results despite changed arguments", () => {
    const tracker = new ToolLoopTracker();

    for (let i = 0; i < 6; i++) {
      const args = {
        cmd: `grep -n shadow fixture.py | head -n ${i < 5 ? 50 : 100}`,
      };
      tracker.check("os.shell.run", args);
      tracker.recordCall("os.shell.run", args);
      tracker.recordOutcome("os.shell.run", args, {
        tool: "os.shell.run",
        status: "ok",
        summary: "… [omitted 18 lines]\n42: shadow = True",
        details: { exitCode: 0 },
        truncated: true,
      });
    }

    expect(tracker.isOutcomeRepeatBreakerTripped()).toBe(true);
  });

  it("allows distinct file reads with identical summary labels", () => {
    const tracker = new ToolLoopTracker();

    for (let i = 0; i < 12; i++) {
      const args = { path: `file-${i}.ts` };
      expect(tracker.check("os.fs.read", args).level).toBe("ok");
      tracker.recordCall("os.fs.read", args);
      tracker.recordOutcome("os.fs.read", args, {
        tool: "os.fs.read",
        status: "ok",
        summary: "os.fs.read",
        details: { content: `export const value = ${i};` },
        truncated: false,
      });
    }

    expect(tracker.isOutcomeRepeatBreakerTripped()).toBe(false);
    expect(tracker.isNoWriteProgressBreakerTripped()).toBe(false);
  });
});
