import { describe, expect, it } from "vitest";
import {
  appendReasoningDelta,
  capStreamText,
  STREAM_RENDER_CAP,
} from "./reducer-helpers.js";
import type { TuiState } from "./tui-state.js";

/** Only `reasoning` + `ringBufferSize` are read by the functions under test. */
const state = (): TuiState =>
  ({ reasoning: [], ringBufferSize: 50 }) as unknown as TuiState;

describe("capStreamText", () => {
  it("leaves a short block untouched", () => {
    expect(capStreamText("abc")).toBe("abc");
  });

  it("caps a long block, keeps both ends, and marks the elision", () => {
    const capped = capStreamText("x".repeat(STREAM_RENDER_CAP * 4));
    expect(capped.length).toBeLessThanOrEqual(STREAM_RENDER_CAP + 40);
    expect(capped).toContain("chars elided");
    expect(capped.startsWith("x".repeat(16))).toBe(true);
    expect(capped.endsWith("x".repeat(16))).toBe(true);
  });
});

describe("appendReasoningDelta", () => {
  // The crash this guards: an unbounded growing block is re-allocated on every
  // streamed chunk, which walked V8 into its heap ceiling mid-session.
  it("keeps accumulation bounded across thousands of chunks", () => {
    let s = state();
    for (let i = 0; i < 5000; i += 1) {
      s = appendReasoningDelta(s, { stepIndex: 1, text: "0123456789" });
    }
    expect(s.reasoning).toHaveLength(1);
    expect(s.reasoning[0]!.text.length).toBeLessThanOrEqual(STREAM_RENDER_CAP + 60);
  });
});
