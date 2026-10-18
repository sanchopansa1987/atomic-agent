import { describe, expect, it } from "vitest";

import { contrastRatio } from "./theme/color-contrast.js";
import { THEMES, THEME_NAMES, type ThemeName } from "./theme/theme.js";

/**
 * The composer sits on a panel the *app* paints (`badgeBackground`), and
 * the buffer used to be drawn with no foreground at all — inheriting the
 * terminal's default ink. That only works while the panel and the
 * terminal agree about which way round light and dark are, and they need
 * not: `classic-light` paints a near-white panel, so anyone running a
 * light palette in a dark terminal typed light text onto it and could
 * not read what they were writing.
 */
describe("what colour the composer types in", () => {
  it("keeps that colour readable against the panel it sits on", () => {
    for (const name of THEME_NAMES) {
      const colors = THEMES[name].colors;
      const chosen =
        contrastRatio(colors.badgeBackground, colors.chipBackground) >=
        contrastRatio(colors.badgeBackground, colors.chipForeground)
          ? colors.chipBackground
          : colors.chipForeground;
      const ratio = contrastRatio(chosen, colors.badgeBackground);
      expect(
        ratio,
        `${name}: ${ratio.toFixed(2)}:1 on the composer panel`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("picks the chip fill on both light and dark palettes", () => {
    // `ink-testing-library` renders colour-off, so the buffer's paint is
    // asserted on the palette choice itself: the fill — not the foreground
    // — wins the contrast on both polarities (dark on light, light on dark).
    for (const name of ["classic-light", "classic-dark"] as ThemeName[]) {
      const colors = THEMES[name].colors;
      const chosen =
        contrastRatio(colors.badgeBackground, colors.chipBackground) >=
        contrastRatio(colors.badgeBackground, colors.chipForeground)
          ? colors.chipBackground
          : colors.chipForeground;
      expect(chosen, `${name}: buffer should use the chip fill`).toBe(
        colors.chipBackground,
      );
    }
  });
});
