import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

import {
  extractQuery,
  formatForPrompt,
  getTdaiGatewayConfig,
  injectSectionBeforeConversation,
  prependSectionToLastUserTurn,
  searchMemory,
  type MemoryHit,
} from "./tdai-gateway.js";

function configJson(): string {
  return JSON.stringify({
    memory: {
      tdaiGateway: {
        enabled: true,
        baseUrl: "http://127.0.0.1:8420",
        serviceId: "atomic-live",
        topK: 5,
        timeoutMs: 3000,
      },
    },
    llm: {
      providers: [
        {
          id: "freellmapi",
          headers: { "x-agent-id": "agt-test", "x-team-id": "team-test" },
        },
      ],
    },
  });
}

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => data } as unknown as Response;
}

describe("tdai-gateway", () => {
  beforeEach(() => {
    vi.mocked(readFileSync).mockReturnValue(configJson());
    process.env.TDAI_GATEWAY_API_KEY = "test-gateway-key";
    process.env.TDAI_ADMIN_KEY = "test-admin-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.TDAI_GATEWAY_API_KEY;
    delete process.env.TDAI_ADMIN_KEY;
  });

  describe("getTdaiGatewayConfig", () => {
    it("reads the config block from the file", () => {
      const cfg = getTdaiGatewayConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.baseUrl).toBe("http://127.0.0.1:8420");
      expect(cfg.topK).toBe(5);
    });

    it("falls back to defaults when the block is absent", () => {
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({}));
      const cfg = getTdaiGatewayConfig();
      expect(cfg.enabled).toBe(false);
      expect(cfg.baseUrl).toBe("http://127.0.0.1:8420");
      expect(cfg.serviceId).toBe("atomic-live");
    });
  });

  describe("searchMemory", () => {
    it("returns [] on network failure without throwing", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      );
      await expect(searchMemory("query")).resolves.toEqual([]);
    });

    it("returns [] when the gateway responds non-2xx", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({}, false, 500)),
      );
      await expect(searchMemory("query")).resolves.toEqual([]);
    });

    it("parses a successful gateway response into hits", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            code: 0,
            data: {
              owner_user_id: "usr-test",
              agent_id: "agt-test",
              team_id: "team-test",
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            code: 0,
            data: {
              messages: [{ id: "m1", content: "hello memory" }],
            },
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const hits = await searchMemory("hello");
      expect(hits).toEqual([
        { id: "m1", source: "tdai", content: "hello memory", score: 0 },
      ]);
    });

    it("returns [] when there are no hits", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ code: 0, data: { owner_user_id: "usr-test" } }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ code: 0, data: { messages: [] } }),
        );
      vi.stubGlobal("fetch", fetchMock);

      await expect(searchMemory("nope")).resolves.toEqual([]);
    });
  });

  describe("formatForPrompt", () => {
    it("renders hits in a stable format", () => {
      const hits: MemoryHit[] = [
        { id: "1", source: "tdai", content: "alpha", score: 0 },
        { id: "2", source: "tdai", content: "beta", score: 0 },
      ];
      expect(formatForPrompt(hits)).toBe("### relevant memory\nalpha\nbeta");
    });

    it("returns empty string for no hits", () => {
      expect(formatForPrompt([])).toBe("");
    });
  });

  describe("extractQuery", () => {
    it("strips code fences and URLs", () => {
      expect(extractQuery("hello ```code``` https://example.com/x world")).toBe(
        "hello world",
      );
    });

    it("returns empty for null/undefined", () => {
      expect(extractQuery(null)).toBe("");
      expect(extractQuery(undefined)).toBe("");
    });

    it("caps at 200 chars", () => {
      expect(extractQuery("x".repeat(500)).length).toBe(200);
    });
  });

  describe("injectSectionBeforeConversation", () => {
    it("inserts the section immediately before ### conversation", () => {
      const text = "prefix\n### conversation\nrest";
      const out = injectSectionBeforeConversation(
        text,
        "### relevant memory\nhit",
      );
      expect(out).toBe(
        "prefix\n### relevant memory\nhit\n\n### conversation\nrest",
      );
    });
  });

  describe("prependSectionToLastUserTurn", () => {
    it("prepends to the last user turn only (messages path)", () => {
      const messages = {
        system: "sys",
        droppedSummary: null,
        tail: "tail",
        turns: [
          { kind: "user", text: "first" },
          { kind: "assistant_reply", text: "reply" },
          { kind: "user", text: "last" },
        ],
      };
      const out = prependSectionToLastUserTurn(messages as never, "SECTION");
      expect((out.turns[2] as { text: string }).text).toBe("SECTION\n\nlast");
      expect((out.turns[0] as { text: string }).text).toBe("first");
      expect((out.turns[1] as { text: string }).text).toBe("reply");
    });
  });
});
