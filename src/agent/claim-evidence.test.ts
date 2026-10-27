import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "../session/conversation-turn.js";
import {
  claimHasEvidence,
  detectCheckClaims,
  formatTruncatedEvidenceNotice,
  formatUnverifiedClaimNotice,
  formatUnverifiedClaimRefusal,
  truncatedEvidenceClaims,
  turnToolCalls,
  unverifiedClaims,
} from "./claim-evidence.js";

const shell = (cmd: string, args: string[] = []) => ({
  tool: "os.shell.run",
  args: { cmd, args },
});

describe("detectCheckClaims", () => {
  it("finds the claims the failing replies made, one per kind, in order", () => {
    // Run 12: "Ran node --check on all JavaScript files (all passed)".
    expect(
      detectCheckClaims("Ran node --check on all JavaScript files (all passed)."),
    ).toEqual([{ kind: "node-check", text: "node --check" }]);
    expect(detectCheckClaims("All 12 tests pass. I verified the layout.")).toEqual([
      { kind: "tests", text: "tests pass" },
      { kind: "verified", text: "verified" },
    ]);
    expect(detectCheckClaims("I ran the tests and lint passes; it builds cleanly.")).toEqual([
      { kind: "tests", text: "ran the tests" },
      { kind: "lint", text: "lint passes" },
      { kind: "build", text: "builds cleanly" },
    ]);
  });

  it("does not fire on ordinary prose", () => {
    expect(detectCheckClaims("Here is the file. Run the tests when you like.")).toEqual([]);
    expect(detectCheckClaims("The build step is next; nothing checked yet.")).toEqual([]);
  });
});

describe("claimHasEvidence", () => {
  it("accepts a shell command containing the claimed check", () => {
    const nodeCheck = { kind: "node-check" as const, text: "node --check" };
    expect(claimHasEvidence(nodeCheck, [shell("node", ["--check", "a.js"])])).toBe(true);
    expect(claimHasEvidence(nodeCheck, [shell("node -c js/a.js")])).toBe(true);
    expect(claimHasEvidence(nodeCheck, [shell("node", ["js/a.js"])])).toBe(false);
    expect(claimHasEvidence(nodeCheck, [shell("ls")])).toBe(false);
    const tests = { kind: "tests" as const, text: "tests pass" };
    expect(claimHasEvidence(tests, [shell("npx", ["vitest", "run"])])).toBe(true);
    expect(claimHasEvidence(tests, [shell("npm test")])).toBe(true);
    expect(claimHasEvidence(tests, [shell("cat", ["a.js"])])).toBe(false);
  });

  it("accepts any verify.* call for any claim", () => {
    for (const kind of ["node-check", "tests", "verified", "lint", "build"] as const) {
      expect(
        claimHasEvidence({ kind, text: "x" }, [{ tool: "verify.syntax", args: {} }]),
      ).toBe(true);
    }
  });

  it("reads a bare 'verified' as backed by any command the turn ran", () => {
    const verified = { kind: "verified" as const, text: "verified" };
    expect(claimHasEvidence(verified, [shell("ls")])).toBe(true);
    expect(claimHasEvidence(verified, [{ tool: "os.fs.read", args: {} }])).toBe(false);
  });
});

describe("unverifiedClaims / turnToolCalls", () => {
  it("returns only the claims nothing backs", () => {
    expect(
      unverifiedClaims("tests pass and node --check passed", [shell("node --check a.js")]),
    ).toEqual([{ kind: "tests", text: "tests pass" }]);
    expect(unverifiedClaims("tests pass", [{ tool: "verify.run", args: {} }])).toEqual([]);
  });

  it("reads this turn's calls: everything after the last user turn", () => {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "build it", at: 1 },
      { kind: "assistant_tool_call", tool: "os.shell.run", args: { cmd: "node --check a.js" }, at: 2 },
      { kind: "tool_result", tool: "os.shell.run", status: "ok", summary: "", at: 3 },
      { kind: "assistant_reply", text: "done", at: 4 },
      { kind: "user", text: "now fix it", at: 5 },
      { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "a.js" }, at: 6 },
      { kind: "tool_result", tool: "os.fs.read", status: "ok", summary: "", at: 7 },
    ];
    expect(turnToolCalls(turns)).toEqual([{ tool: "os.fs.read", args: { path: "a.js" } }]);
    // The earlier turn's node --check is not evidence for this turn.
    expect(unverifiedClaims("node --check passed", turnToolCalls(turns))).toHaveLength(1);
  });

  it("names the claim and both exits in the notice", () => {
    const notice = formatUnverifiedClaimNotice([{ kind: "tests", text: "tests pass" }]);
    expect(notice).toContain('claims "tests pass"');
    expect(notice).toContain("no such check ran this turn");
    expect(notice).toContain("`verify.run`");
    expect(notice).toContain("`os.shell.run`");
    expect(notice).toContain("remove the claim");
  });

  it("treats a truncated result as no evidence and names it separately", () => {
    // The check ran — but the model only saw an elided fraction of the output.
    const elided = [{ ...shell("npx vitest run"), truncated: true }];
    expect(claimHasEvidence({ kind: "tests", text: "tests pass" }, elided)).toBe(false);
    expect(unverifiedClaims("tests pass", elided)).toHaveLength(1);
    const truncated = truncatedEvidenceClaims("tests pass", elided);
    expect(truncated).toEqual([{ kind: "tests", text: "tests pass" }]);
    expect(formatTruncatedEvidenceNotice(truncated)).toContain("truncated");
    // Nothing truncated: the claim is simply backed.
    const whole = [shell("npx vitest run")];
    expect(truncatedEvidenceClaims("tests pass", whole)).toHaveLength(0);
    expect(unverifiedClaims("tests pass", whole)).toHaveLength(0);
  });

  it("marks a call truncated from its own tool_result turn", () => {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "check it", at: 1 },
      { kind: "assistant_tool_call", tool: "os.shell.run", args: { cmd: "npx vitest run" }, at: 2 },
      { kind: "tool_result", tool: "os.shell.run", status: "ok", summary: "", truncated: true, at: 3 },
    ];
    expect(turnToolCalls(turns)).toEqual([
      { tool: "os.shell.run", args: { cmd: "npx vitest run" }, truncated: true },
    ]);
    expect(unverifiedClaims("all tests pass", turnToolCalls(turns))).toHaveLength(1);
  });

  it("names the call that ran and exited 0 when the claim is refused", () => {
    const claim = [{ kind: "tests", text: "tests pass" }];
    const ran = [{ tool: "os.shell.run", args: { cmd: "npx vitest run" }, exitCode: 0 }];
    const refusal = formatUnverifiedClaimRefusal(claim, ran);
    expect(refusal).toContain("os.shell.run exit: 0");
    expect(refusal).toContain('claims "tests pass"');
  });

  it("keeps today's wording verbatim when nothing ran", () => {
    const claim = [{ kind: "tests", text: "tests pass" }];
    const today =
      'not delivered: the reply claims "tests pass" but no matching check ran this turn. Run the check (`verify.run`, `os.shell.run`) or remove the claim, then reply again.';
    expect(formatUnverifiedClaimRefusal(claim)).toBe(today);
    expect(formatUnverifiedClaimRefusal(claim, [])).toBe(today);
  });

  it("says a truncated verify result is retrievable and names its blob prefix", () => {
    const claim = [{ kind: "verified", text: "verified" }];
    const ran = [
      { tool: "verify.run", args: {}, truncated: true, blob: "abcdef1234567890" },
    ];
    const refusal = formatUnverifiedClaimRefusal(claim, ran);
    expect(refusal).toContain("retrievable");
    expect(refusal).toContain("tool.recall abcdef12");
  });
});
