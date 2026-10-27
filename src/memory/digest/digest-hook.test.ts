import { describe, expect, it, vi } from "vitest";
import type { DigestWorkItem } from "../../agent/agent-loop.js";
import { createDigestHook, DIGEST_MAX_BODY_CHARS, type DigestRunner } from "./digest-hook.js";

function item(title: string, body = "body"): DigestWorkItem {
  return { sessionId: "s", title, body, tags: [] };
}

describe("createDigestHook (queue #9)", () => {
  it("a throwing runner does not rethrow, logs WARN, and the next item still runs", async () => {
    const warns: Array<Record<string, unknown>> = [];
    const ran: string[] = [];
    let fail = true;
    const runner: DigestRunner = async ({ title }) => {
      ran.push(title);
      if (fail) throw new Error("boom");
    };
    const hook = createDigestHook({
      runner,
      logger: { warn: (message, fields) => warns.push({ message, ...fields }) } as never,
    });
    hook.recordWorkItem(item("one"));
    fail = false;
    hook.recordWorkItem(item("two"));
    await vi.waitFor(() => expect(warns).toHaveLength(1));
    expect(ran).toEqual(["one", "two"]);
    expect(warns[0]?.title).toBe("one");
  });

  it("deduplicates duplicate titles into one runner call", () => {
    const ran: string[] = [];
    const runner: DigestRunner = async ({ title }) => {
      ran.push(title);
    };
    const hook = createDigestHook({ runner });
    hook.recordWorkItem(item("same"));
    hook.recordWorkItem(item("same"));
    hook.recordWorkItem(item("other"));
    expect(ran).toEqual(["same", "other"]);
  });

  it("gate off makes recordWorkItem a no-op", () => {
    const ran: string[] = [];
    const runner: DigestRunner = async ({ title }) => {
      ran.push(title);
    };
    const hook = createDigestHook({ runner, enabled: false });
    hook.recordWorkItem(item("x"));
    expect(ran).toEqual([]);
  });

  it("truncates the body at the ceiling and says so", () => {
    let received = "";
    const runner: DigestRunner = async ({ body }) => {
      received = body;
    };
    const hook = createDigestHook({ runner });
    const long = "x".repeat(DIGEST_MAX_BODY_CHARS + 500);
    hook.recordWorkItem(item("t", long));
    expect(received.length).toBeLessThan(long.length);
    expect(received).toContain("truncated");
    expect(received.startsWith("x".repeat(DIGEST_MAX_BODY_CHARS))).toBe(true);
  });
});
