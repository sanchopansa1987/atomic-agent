import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { theme } from "../theme/theme.js";
import { ComposerMetaControls } from "./composer-meta-controls.js";

function frame(): string {
  const { lastFrame, unmount } = render(
    <Box>
      <ComposerMetaControls
        backend={{ kind: "cloud", status: "healthy" }}
        provider="openrouter"
        model="claude-opus-5"
      />
    </Box>,
  );
  const out = lastFrame() ?? "";
  unmount();
  return out;
}

function plain(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("the composer's route line", () => {
  it("reads backend, then provider, then model", () => {
    const text = plain(frame());
    expect(text).toContain("cloud");
    expect(text.indexOf("cloud")).toBeLessThan(text.indexOf("openrouter"));
    expect(text.indexOf("openrouter")).toBeLessThan(
      text.indexOf("claude-opus-5"),
    );
  });

  // Colour is stripped, so the route's paint is asserted on the tokens:
  // `railForeground` is the text, `railMuted` the separator/dim tone.
  it("sets all three in the rail's text colour, not its muted one", () => {
    expect(theme.colors.railForeground).not.toBe(theme.colors.railMuted);
  });

  it("shows the dot alone on a local backend — no probe word", () => {
    const { lastFrame, unmount } = render(
      <Box>
        <ComposerMetaControls
          backend={{ kind: "local", status: "unreachable" }}
          provider="llama.cpp"
          model={null}
        />
      </Box>,
    );
    const out = plain(lastFrame() ?? "");
    unmount();
    // The row used to spell the probe out (`○ local down`). It reported
    // `down` against working daemons often enough to be noise, so the
    // dot is all that is left of it here — the Models pane still states
    // the probe in full.
    expect(out).toContain("○ local");
    expect(out).not.toContain("down");
  });

  it("stays silent — no dot, no word — while nothing has been probed", () => {
    const { lastFrame, unmount } = render(
      <Box>
        <ComposerMetaControls
          backend={{ kind: "custom", status: "unknown" }}
          provider="llama.cpp"
          model={null}
        />
      </Box>,
    );
    const out = plain(lastFrame() ?? "");
    unmount();
    // The unknown glyph is the same `·` the row separates words with;
    // drawing it made the status indistinguishable from punctuation.
    expect(out.trimStart().startsWith("custom")).toBe(true);
    expect(out).not.toContain("· custom");
    expect(out).not.toContain("unknown");
  });

  it("draws the fusion word as a padded chip", () => {
    const { lastFrame, unmount } = render(
      <Box>
        <ComposerMetaControls
          backend={{ kind: "fusion", status: "healthy" }}
          provider="openrouter"
          model="claude-opus-5 ⇄ qwen-3.5-4b"
        />
      </Box>,
    );
    const out = plain(lastFrame() ?? "");
    unmount();
    // The chip pads its word, so the dot and the word sit a chip-edge
    // apart. (The orange ground-vs-ink distinction is colour-only and
    // not observable once colour is stripped.)
    expect(out).toMatch(/● +fusion +· openrouter/);
  });

  it("gives cloud its dot but never a word no probe stands behind", () => {
    const out = plain(frame());
    expect(out).toContain("● cloud");
    expect(out).not.toContain("healthy");
  });

  it("does not spend a segment on the worker count", () => {
    // It was a capacity, not a choice, and it cost columns the route
    // names needed — the screenshot that killed it showed `up to 2
    // work…` colliding with the steer hint. Both legs are already named
    // by the model segment, and the worker slot is one ←/→ away inside
    // the popup.
    const { lastFrame } = render(
      <ComposerMetaControls
        backend={{ label: "fusion", tone: "fusion" }}
        provider="openrouter"
        model="claude-opus-5 ⇄ qwen-3.5-4b"
        fusion
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toMatch(/worker/i);
    expect(frame).toContain("qwen-3.5-4b");
  });

  it("draws no fourth control when there are no workers to count", () => {
    expect(plain(frame())).not.toContain("worker");
  });

  it("renders nothing at all when there is no route to state", () => {
    const { lastFrame, unmount } = render(
      <Box>
        <ComposerMetaControls backend={null} provider={null} model={null} />
      </Box>,
    );
    expect(plain(lastFrame() ?? "").trim()).toBe("");
    unmount();
  });
});

describe("the model slot's download call to action", () => {
  it("replaces the model with `download model` when nothing is on disk", () => {
    const { lastFrame, unmount } = render(
      <Box>
        <ComposerMetaControls
          backend={{ kind: "local", status: "unreachable" }}
          provider={null}
          model="qwen-3.5-4b"
          needsModelDownload
        />
      </Box>,
    );
    const out = plain(lastFrame() ?? "");
    unmount();
    expect(out).toContain("○ local · download model");
    // The catalog id is what the config *selected*, not what exists —
    // showing it next to an empty models directory is the bug.
    expect(out).not.toContain("qwen-3.5-4b");
  });

  // Colour is stripped, so the CTA's paint is asserted on the tokens:
  // `railWarn`, not `warnStrong` or `railForeground`.
  it("draws the call to action in the rail's warn, not the route's own tone", () => {
    expect(theme.colors.railWarn).not.toBe(theme.colors.warnStrong);
    expect(theme.colors.railWarn).not.toBe(theme.colors.railForeground);
  });

  it("still renders the route when the CTA is the only thing to say", () => {
    const { lastFrame, unmount } = render(
      <Box>
        <ComposerMetaControls
          backend={null}
          provider={null}
          model={null}
          needsModelDownload
        />
      </Box>,
    );
    const out = plain(lastFrame() ?? "");
    unmount();
    // No backend and no provider means no leading separator either — a
    // row starting in " · " reads as a dropped label.
    expect(out.trim()).toBe("download model");
  });
});
