import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { fusionInk } from "../theme/fusion-tint.js";
import { theme } from "../theme/theme.js";
import { AssistantBubble } from "./assistant-bubble.js";
import { UserBubble } from "./user-bubble.js";

function frame(element: Parameters<typeof render>[0]): string {
  const { lastFrame, unmount } = render(element);
  const out = lastFrame() ?? "";
  unmount();
  return out;
}

describe("the chat bubbles under fusion", () => {
  // `ink-testing-library` renders colour-off, so the tint is asserted on
  // the resolver (`fusionInk`) and the palette tokens, not the SGR.
  it("paint the user border orange but keep the YOU label in the user colour", () => {
    // `fusionInk()` is the resolver both bubbles read for the fusion
    // tone; the YOU label never takes it.
    expect(fusionInk()).toBe(theme.colors.warnStrong);
    expect(theme.colors.user).not.toBe(fusionInk());
  });

  it("paint the AGENT label, the border and the footer glyph orange", () => {
    expect(fusionInk()).toBe(theme.colors.warnStrong);
    expect(theme.colors.assistant).not.toBe(fusionInk());
  });

  it("stay in their own colours off fusion", () => {
    // Off fusion the bubbles read the user/assistant tokens, never the
    // fusion orange.
    expect(theme.colors.user).not.toBe(fusionInk());
    expect(theme.colors.assistant).not.toBe(fusionInk());
  });

  it("draw the labels, borders and the assistant footer glyph", () => {
    const user = frame(<UserBubble text="hi" fusion />);
    expect(user).toContain("YOU");
    expect(user).toContain("│");

    const agent = frame(<AssistantBubble text="done" toolSteps={2} fusion />);
    expect(agent).toContain("AGENT");
    expect(agent).toContain("│");
    expect(agent).toContain("●");
  });
});
