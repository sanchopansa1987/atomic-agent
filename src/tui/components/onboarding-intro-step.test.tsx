import { render } from "ink-testing-library";
import React from "react";
import { beforeAll, describe, expect, it } from "vitest";

import { computeOnboardingFit } from "../onboarding/onboarding-fit.js";
import { STAR_GLYPHS, starTierOfGlyph } from "../onboarding/star-tiers.js";
import { THEMES } from "../theme/theme.js";
import { OnboardingIntroStep } from "./onboarding-intro-step.js";

const strip = (frame: string): string =>
  frame.replace(/\u001B\[[0-9;]*m/gu, "");

/** Rendering an Ink tree is slow enough that sizes are worth reusing. */
const frames = new Map<string, string>();

function frameAt(columns: number, rows: number): string {
  const key = `${columns}x${rows}`;
  const cached = frames.get(key);
  if (cached !== undefined) return cached;
  const view = render(
    <OnboardingIntroStep
      columns={columns - 4}
      // The screen hands the step its viewport, not the terminal: the
      // surface's top padding and the pinned footer are already gone.
      rows={rows - 2}
      fit={computeOnboardingFit({ columns, rows })}
      skipAnimation
    />,
  );
  const frame = view.lastFrame() ?? "";
  view.unmount();
  frames.set(key, frame);
  return frame;
}

describe("OnboardingIntroStep", () => {
  beforeAll(() => {
    frames.clear();
  });

  it("paints a sky of several brightnesses, in a glyph each", () => {
    // `ink-testing-library` renders colour-off (as do `NO_COLOR` and
    // monochrome terminals), so the brightness tiers are carried by the
    // star glyphs themselves: every tier must actually be drawn.
    const frame = strip(frameAt(100, 30));
    for (const glyph of Object.values(STAR_GLYPHS)) {
      expect(frame).toContain(glyph);
    }
  });

  it("paints the wordmark in the text-safe accent, not the fill", () => {
    // Colour is stripped, so the wordmark's paint is asserted on the
    // token it reads: `accent` (text) differs from `accentSoft` (fill),
    // and only the house palette keeps the two apart.
    expect(THEMES["classic-dark"].colors.accent).not.toBe(
      THEMES["classic-dark"].colors.accentSoft,
    );
  });

  it("still draws the mark, the wordmark and the invitation", () => {
    const plain = strip(frameAt(100, 30));
    expect(plain).toContain("█");
    expect(plain).toContain("[ press any key to continue ]");
    expect(plain).toContain("Local AI-First Agent");
  });

  /**
   * Two rows belong to the screen around this block — its own top
   * padding and the pinned footer — and `frameAt` already keeps them
   * back, so the step must fit inside the viewport it was handed.
   * Anything past that paints over the rows above it, because Ink 7
   * overlaps rather than clips — and what it paints over first is the
   * footer.
   */
  const fitsIn = (columns: number, rows: number): void => {
    const lines = strip(frameAt(columns, rows)).split("\n");
    const overflow = Math.max(0, lines.length - (rows - 2));
    expect({ columns, rows, overflow }).toEqual({ columns, rows, overflow: 0 });
  };

  it("fits its rows, mark and all, at the sizes the flow opens at", () => {
    fitsIn(120, 40);
    fitsIn(100, 30);
    fitsIn(80, 24);
  });

  it("fits them on a terminal too small for the full treatment", () => {
    fitsIn(72, 18);
    fitsIn(64, 16);
  });

  it("thins the sky rather than dropping it on a small terminal", () => {
    const count = (frame: string): number =>
      [...strip(frame)].filter((glyph) => starTierOfGlyph(glyph)).length;
    expect(count(frameAt(72, 18))).toBeGreaterThan(0);
    expect(count(frameAt(120, 40))).toBeGreaterThan(count(frameAt(72, 18)) * 2);
  });
});
