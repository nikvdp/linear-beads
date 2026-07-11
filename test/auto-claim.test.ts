import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Issue } from "../src/types.js";

const calls: string[] = [];
let freshIssue: Issue | null;
let commentError: Error | null;

const openIssue: Issue = {
  id: "LIN-123",
  linear_identifier: "LIN-123",
  title: "Claim me",
  status: "open",
  priority: 2,
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
};

mock.module("../src/utils/config.js", () => ({
  getIssueBackendKind: () => "linear",
  isLocalOnly: () => false,
}));

mock.module("../src/utils/database.js", () => ({
  getCurrentAgentHandle: () => "AmberAster",
}));

mock.module("../src/utils/remote-sync-state.js", () => ({
  formatRemoteSyncPauseNotice: () => "paused",
  getCommandRemoteSyncPause: async () => null,
}));

mock.module("../src/utils/issue-backend.js", () => ({
  fetchIssue: async () => {
    calls.push("fetch");
    return freshIssue;
  },
  getTeamId: async () => "team-1",
  getViewer: async () => ({ id: "viewer-1", email: "nik@example.com", name: "Nik" }),
  updateIssue: async (_id: string, updates: Record<string, unknown>) => {
    calls.push(`update:${updates.status}:${updates.assigneeId}`);
    return { ...openIssue, status: "in_progress" as const };
  },
  addComment: async (_id: string, body: string) => {
    calls.push(`comment:${body}`);
    if (commentError) throw commentError;
    return {};
  },
}));

const { ClaimLostError, claimAutoIssue } = await import("../src/utils/auto.js");

beforeEach(() => {
  calls.length = 0;
  freshIssue = openIssue;
  commentError = null;
});

describe("auto issue claiming", () => {
  test("re-fetches, updates synchronously, then comments", async () => {
    const claimed = await claimAutoIssue(openIssue, { runId: "run-one", worker: "codex-a" });

    expect(claimed.status).toBe("in_progress");
    expect(calls[0]).toBe("fetch");
    expect(calls[1]).toBe("update:in_progress:viewer-1");
    expect(calls[2]).toContain("comment:🤖 claimed by codex-a on ");
    expect(calls[2]).toContain("(run run-one)");
  });

  test("reports a lost claim when the issue is no longer open", async () => {
    freshIssue = { ...openIssue, status: "in_progress" };

    await expect(claimAutoIssue(openIssue, { runId: "run-two" })).rejects.toBeInstanceOf(
      ClaimLostError
    );
    expect(calls).toEqual(["fetch"]);
  });

  test("keeps a confirmed claim when the comment fails", async () => {
    commentError = new Error("comment unavailable");
    const warning = spyOn(console, "warn").mockImplementation(() => {});

    const claimed = await claimAutoIssue(openIssue, { runId: "run-three" });

    expect(claimed.status).toBe("in_progress");
    expect(warning).toHaveBeenCalledWith(
      "Claimed LIN-123, but could not post the claim comment: comment unavailable"
    );
    warning.mockRestore();
  });
});
