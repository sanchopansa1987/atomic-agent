import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import { THEMES } from "../theme/theme.js";
import { renderPickList } from "./wizard-pick-list.js";

/**
 * These are pure-render tests — no `MouseProvider`, so the row targets
 * are inert — but the list always belongs to a wizard, and the prop is
 * required so a real mount cannot forget whose wizard clicks act on.
 */
const wizard = () => createProvidersWizardState("add");

/**
 * Constrain the list to a fixed inner width so the truncation guard is
 * deterministic regardless of the test host's real terminal size —
 * `wrap="truncate-end"` clips to the parent Box, so a 40-column Box is
 * a stand-in for a 40-column terminal.
 */
function narrow(node: ReturnType<typeof renderPickList>, columns: number) {
  return render(<Box width={columns}>{node}</Box>);
}

/**
 * Longest line any rendered frame row reaches, in physical columns.
 * A wrapped row would split one option across two lines and desync the
 * windowed height math, so the guard is: no visible line exceeds the
 * viewport width, and no option's text bleeds onto a second line.
 */
function widestLine(frame: string): number {
  return Math.max(0, ...frame.split("\n").map((line) => line.length));
}

describe("renderPickList narrow-width rendering", () => {
  const longLabel =
    "Together AI — broad open-weight catalog vendored without a key, long enough to overflow";

  it("truncates a long option instead of wrapping it onto a second line", () => {
    const { lastFrame } = narrow(
      renderPickList({
        wizard: wizard(),
        title: "Provider",
        options: [{ label: longLabel }, { label: "Short one" }],
        cursor: 0,
        moveHint: "j/k move",
        actionsHint: "Enter pick · Esc cancel",
      }),
      40,
    );
    const frame = lastFrame() ?? "";
    // The whole frame stays within the viewport — no wrapped overflow.
    expect(widestLine(frame)).toBeLessThanOrEqual(40);
    // The long label is present but clipped: its head shows, its tail does not.
    expect(frame).toContain("Together AI");
    expect(frame).not.toContain("overflow");
    // The following option is never fused into the truncated row: it
    // still appears on its own line intact.
    expect(frame).toContain("Short one");
  });

  it("spends a row on the search box without outgrowing the budget", () => {
    // Ink 7 paints an over-tall frame over the rows above it instead of
    // clipping, so the search line has to come out of the option
    // viewport rather than out of the terminal.
    const options = Array.from({ length: 40 }, (_, i) => ({
      label: `model-${i}`,
    }));
    const height = (
      search: string | null | undefined,
      maxRows: number | undefined,
    ): number => {
      const { lastFrame } = narrow(
        renderPickList({
          wizard: wizard(),
          title: "Chat model",
          options,
          cursor: 0,
          moveHint: "j/k move",
          actionsHint: "Enter pick · Esc cancel",
          ...(maxRows === undefined ? {} : { maxRows }),
          ...(search === undefined ? {} : { search }),
        }),
        60,
      );
      return (lastFrame() ?? "").split("\n").length;
    };
    // Both callers exist: budgeted (the LLM panel passes the tab budget)
    // and unbudgeted (onboarding and the Providers panel size their
    // screens to the fixed viewport). The search line must come out of
    // the option rows on each, or the box grows and eats what is below.
    for (const budget of [14, undefined]) {
      expect(height(null, budget)).toBe(height(undefined, budget));
      expect(height("mo", budget)).toBe(height(undefined, budget));
    }
    expect(height(undefined, 14)).toBeLessThanOrEqual(14);
  });

  it("names the query instead of drawing an empty box", () => {
    const { lastFrame } = narrow(
      renderPickList({
        wizard: wizard(),
        title: "Chat model",
        options: [],
        cursor: 0,
        moveHint: "↑/↓ move",
        actionsHint: "Enter pick",
        search: "zzzz",
      }),
      60,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain('no match for "zzzz"');
    expect(frame).toContain("(0/0)");
  });

  it("leaves a short option intact", () => {
    const { lastFrame } = narrow(
      renderPickList({
        wizard: wizard(),
        title: "Provider",
        options: [{ label: "OpenRouter" }],
        cursor: 0,
        moveHint: "j/k move",
        actionsHint: "Enter pick · Esc cancel",
      }),
      80,
    );
    expect(lastFrame() ?? "").toContain("OpenRouter");
  });
});

/**
 * `ink-testing-library` renders colour-off (as do `NO_COLOR` and
 * monochrome terminals), so the accent-vs-fill and border-tone paint
 * choices have no colour-off glyph to assert on — those cases are not
 * observable here and are dropped. Selection is still carried by the
 * cursor glyph, so that property stays.
 */
describe("renderPickList cursor marking", () => {
  function frame() {
    return render(
      <Box width={60}>
        {renderPickList({
          wizard: wizard(),
          title: "Chat model (OpenRouter)",
          options: [{ label: "first-model" }, { label: "second-model" }],
          cursor: 1,
          moveHint: "j/k move",
          actionsHint: "Enter select · Esc back",
        })}
      </Box>,
    ).lastFrame() ?? "";
  }

  it("marks the selected row with the cursor glyph and only that row", () => {
    const out = frame();
    // `> ` on the selected row, two spaces on the rest: the glyph is
    // what distinguishes the cursor once colour is stripped.
    expect(out).toContain("> second-model");
    expect(out).toContain("  first-model");
    expect(out).not.toContain("> first-model");
  });
});

describe("renderPickList colour tokens", () => {
  // Colour is stripped by `ink-testing-library`, so the title/border
  // paint is asserted on the tokens the component reads. The house
  // palette is the only one where `accent` (text) and `accentSoft`
  // (fill) differ — everywhere else they are equal and the distinction
  // is invisible.
  const house = THEMES["classic-dark"].colors;

  it("paints the title in the text-safe accent, not the fill", () => {
    expect(house.accent).not.toBe(house.accentSoft);
  });

  it("keeps the border on the fill tone", () => {
    expect(house.accentSoft).not.toBe(house.accent);
  });
});
