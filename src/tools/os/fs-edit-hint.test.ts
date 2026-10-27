import { describe, it, expect } from "vitest";
import { nearestMatchHint } from "./fs-edit.js";

describe("nearestMatchHint", () => {
  const file = [
    "function alpha() {",
    "  return 1;",
    "}",
    "",
    "function beta() {",
    "  return 2;",
    "}",
    "",
    "const grandTotal = 42;",
  ].join("\n");

  it("names the closest line when the anchor drifted", () => {
    // The recorded failure: the caller restated a line slightly wrong and got
    // only "not found", with no way to see how the file had moved.
    const hint = nearestMatchHint(file, "const grandTotal = 43;");
    expect(hint).toContain("line 9");
    expect(hint).toContain("const grandTotal = 42;");
  });

  it("admits when nothing in the file is close", () => {
    expect(nearestMatchHint(file, "zzzz qqqq xxxx yyyy")).toContain("No similar line");
  });

  it("says nothing for an empty anchor", () => {
    expect(nearestMatchHint(file, "   \n  ")).toBe("");
  });
});
