import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "./blob-store.js";
import { SessionStore } from "./session-store.js";
import { createEmptySessionState, type SessionState } from "./session-state.js";
import { assistantReplyTurn, toolResultTurn, userTurn } from "./conversation-turn.js";

describe("legacy session blob migration", () => {
  let dir: string;
  let store: SessionStore;
  let legacy: SessionStore;
  let blobs: BlobStore;
  let state: SessionState;
  const body = "legacy output  \r\n\r\n" + "text 😀\n".repeat(1500);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-session-blobs-"));
    const dbFile = join(dir, "sessions.sqlite");
    blobs = new BlobStore({ rootDir: join(dir, "blobs") });
    legacy = new SessionStore({ dbFile });
    store = new SessionStore({ dbFile, blobStore: blobs });
    state = {
      ...createEmptySessionState({ id: "old", workingDir: dir }),
      createdAt: 100,
      updatedAt: 200,
      turns: [
        userTurn("read the file", 101),
        toolResultTurn({ tool: "os.fs.read", status: "ok", summary: body, at: 102 }),
        assistantReplyTurn("done", 103),
      ],
      latestResult: { tool: "os.fs.read", status: "ok", summary: body, details: { path: "old.txt" } },
    };
    legacy.save(state);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    legacy.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["load", "listRecent", "listByWorkingDir"] as const)(
    "%s migrates and persists oversized results once, preserving their exact text",
    async (method) => {
      const put = vi.spyOn(blobs, "putSync");
      const migrated = method === "load" ? store.load("old")!
        : method === "listRecent" ? store.listRecent()[0]!
        : store.listByWorkingDir(dir)[0]!;
      const turn = migrated.turns[1];
      if (turn?.kind !== "tool_result") throw new Error("missing tool result");
      expect(turn.blob).toMatch(/^[a-f0-9]{64}$/);
      expect(await blobs.get(turn.blob!)).toBe(body);
      expect(turn).toMatchObject({ summary: body.slice(0, 8000), truncated: true, at: 102 });
      expect(migrated.latestResult).toMatchObject({
        blob: turn.blob, summary: body.slice(0, 8000), details: { path: "old.txt" },
      });
      expect(migrated).toEqual({ ...state, turns: migrated.turns, latestResult: migrated.latestResult });
      expect(migrated.turns[0]).toEqual(state.turns[0]);
      expect(migrated.turns[2]).toEqual(state.turns[2]);
      expect(legacy.load("old")).toEqual(migrated);
      put.mockClear();
      expect(store.load("old")).toEqual(migrated);
      expect(put).not.toHaveBeenCalled();
    },
  );

  it("leaves sessions unchanged without a blob store or on summary-only listings", () => {
    const put = vi.spyOn(blobs, "putSync");
    expect(legacy.load("old")).toEqual(state);
    expect(store.listSummaries()[0]?.id).toBe("old");
    expect(store.listRecentWorkingDirs()[0]?.workingDir).toBe(dir);
    expect(put).not.toHaveBeenCalled();
    expect(legacy.load("old")).toEqual(state);
  });

  it("preserves short results, existing references, replies, and recall pages", () => {
    const put = vi.spyOn(blobs, "putSync");
    const turns = [
      userTurn(body),
      assistantReplyTurn(body),
      toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "x".repeat(8000) }),
      toolResultTurn({ tool: "os.fs.read", status: "ok", summary: body, blob: "a".repeat(64) }),
      ...["reply", "finish", "tool.recall"].map((tool) =>
        toolResultTurn({ tool, status: "ok", summary: body }),
      ),
    ];
    const unchanged = { ...state, turns, latestResult: null };
    legacy.save(unchanged);
    expect(store.load("old")).toEqual(unchanged);
    expect(put).not.toHaveBeenCalled();
  });

  it("preserves the complete session if a later blob write fails, then retries", () => {
    state.turns.push(toolResultTurn({ tool: "os.shell.run", status: "error", summary: body + "error" }));
    legacy.save(state);
    const put = blobs.putSync.bind(blobs);
    const spy = vi.spyOn(blobs, "putSync")
      .mockImplementationOnce(put)
      .mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(store.load("old")).toEqual(state);
    expect(legacy.load("old")).toEqual(state);
    expect(store.unreadableRowsSkipped).toBe(0);
    spy.mockRestore();
    expect(store.load("old")?.latestResult?.blob).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns the original session when saving the migration fails", () => {
    vi.spyOn(store, "save").mockImplementationOnce(() => { throw new Error("database is locked"); });
    expect(store.load("old")).toEqual(state);
    expect(legacy.load("old")).toEqual(state);
    expect(store.unreadableRowsSkipped).toBe(0);
    expect(store.load("old")?.latestResult?.blob).toMatch(/^[a-f0-9]{64}$/);
  });
});
