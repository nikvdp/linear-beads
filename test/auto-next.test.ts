import { describe, expect, test } from "bun:test";
import type { Issue } from "../src/types.js";
import {
  claimedPayload,
  nextAutoPollDelayMs,
  noWorkPayload,
  resolveAutoWaitTimeoutMs,
} from "../src/commands/auto.js";

const issue: Issue = {
  id: "LIN-123",
  linear_identifier: "LIN-123",
  title: "Claimed work",
  description: "Full ticket body",
  status: "in_progress",
  priority: 2,
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
};

describe("auto next payloads", () => {
  test("resolves CLI, environment, and default wait timeouts", () => {
    expect(resolveAutoWaitTimeoutMs("5000", { LB_AUTO_WAIT_TIMEOUT_MS: "9000" })).toBe(5000);
    expect(resolveAutoWaitTimeoutMs(undefined, { LB_AUTO_WAIT_TIMEOUT_MS: "9000" })).toBe(9000);
    expect(resolveAutoWaitTimeoutMs(undefined, {})).toBe(480000);
    expect(() => resolveAutoWaitTimeoutMs("0", {})).toThrow(
      "--timeout-ms must be a positive integer."
    );
  });

  test("caps polling at the remaining wait budget", () => {
    expect(nextAutoPollDelayMs(10000, 30000, 7000)).toBe(3000);
    expect(nextAutoPollDelayMs(10000, 1000, 7000)).toBe(1000);
    expect(nextAutoPollDelayMs(10000, 1000, 11000)).toBe(0);
  });

  test("names the polled queue in the successful no-work response", () => {
    expect(noWorkPayload("auto:codex-a")).toEqual({
      status: "no_work",
      message:
        "No work labeled auto:codex-a is ready. This is not an error. Run `lb auto next --wait` again to continue polling.",
    });
  });

  test("returns the full issue and branch-first handoff instructions", () => {
    expect(claimedPayload(issue, "/repo/.worktrees/run-one")).toEqual({
      status: "claimed",
      issue,
      workdir: "/repo/.worktrees/run-one",
      instructions:
        "You have claimed this ticket. cd to /repo/.worktrees/run-one, create a branch first, implement the ticket, commit, then `lb close LIN-123 --reason ...`.",
    });
    expect(claimedPayload(issue, null)).toMatchObject({
      status: "claimed",
      workdir: null,
    });
  });
});
