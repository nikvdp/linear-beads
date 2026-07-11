import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentRun } from "../src/types.js";
import {
  formatRelativeTime,
  observeAgentRun,
  tailLogFile,
} from "../src/commands/auto.js";

const tempDirs: string[] = [];
const baseRun: AgentRun = {
  id: "run-one",
  issue_id: "LOCAL-1",
  agent_name: "codex",
  status: "running",
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
};

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("auto run observation", () => {
  test("computes live and stale states without mutating stored rows", () => {
    const live = observeAgentRun({ ...baseRun, pid: process.pid });
    const stale = observeAgentRun({ ...baseRun, pid: 2147483647 });
    const flagged = observeAgentRun({ ...baseRun, status: "flagged", pid: process.pid });

    expect(live).toMatchObject({ pid_alive: true, live_state: "running" });
    expect(stale).toMatchObject({
      pid_alive: false,
      live_state: "stale (pid dead — will be reaped by lb auto run)",
    });
    expect(flagged).toMatchObject({ pid_alive: true, live_state: "flagged" });
    expect(baseRun).not.toHaveProperty("pid_alive");
  });

  test("formats simple relative start times", () => {
    const now = Date.parse("2026-07-12T02:00:00.000Z");
    expect(formatRelativeTime("2026-07-12T01:59:30.000Z", now)).toBe("30s ago");
    expect(formatRelativeTime("2026-07-12T01:57:00.000Z", now)).toBe("3m ago");
    expect(formatRelativeTime("2026-07-12T00:00:00.000Z", now)).toBe("2h ago");
  });

  test("tails only the requested lines from the final 64KB", () => {
    const dir = mkdtempSync(join(tmpdir(), "lb-auto-log-"));
    tempDirs.push(dir);
    const path = join(dir, "run.log");
    writeFileSync(path, `${"padding\n".repeat(10000)}last-one\nlast-two\nlast-three\n`);

    expect(tailLogFile(path, 2)).toBe("last-two\nlast-three");
  });
});
