import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { linearStateToStatus, statusToLinearState } from "../src/types.js";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-backlog-status-"));
  tempDirs.push(repoDir);

  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (init.exitCode !== 0) {
    throw new Error("Failed to initialize git repo");
  }

  mkdirSync(join(repoDir, ".lb"), { recursive: true });
  writeFileSync(join(repoDir, ".lb", "config.jsonc"), '{ "local_only": true }\n');
  return repoDir;
}

async function runCli(cwd: string, args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      LB_TEAM_KEY: "",
      LINEAR_API_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function runJson<T>(cwd: string, args: string[]): Promise<T> {
  const result = await runCli(cwd, [...args, "--json"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as T;
}

describe("backlog status support", () => {
  test("maps backlog cleanly to and from Linear workflow state types", () => {
    expect(statusToLinearState("backlog")).toBe("backlog");
    expect(linearStateToStatus("backlog")).toBe("backlog");
  });

  test("update can mark issues as backlog and list can filter backlog directly", async () => {
    const repoDir = createRepo();
    const created = await runJson<Array<{ id: string }>>(repoDir, ["create", "Backlog me"]);

    const updated = await runJson<Array<{ id: string; status: string; closed_at?: string }>>(
      repoDir,
      ["update", created[0].id, "--status", "backlog"]
    );

    expect(updated[0]?.status).toBe("backlog");
    expect(updated[0]?.closed_at).toBeUndefined();

    const listed = await runJson<Array<{ id: string; status: string }>>(repoDir, [
      "list",
      "--status",
      "backlog",
    ]);
    expect(listed.map((issue) => issue.id)).toContain(created[0].id);
    expect(listed[0]?.status).toBe("backlog");
  });

  test("ready excludes backlog while list --status backlog exposes it intentionally", async () => {
    const repoDir = createRepo();
    const backlogIssue = await runJson<Array<{ id: string }>>(repoDir, ["create", "Parked work"]);
    const readyIssue = await runJson<Array<{ id: string }>>(repoDir, ["create", "Active work"]);

    const updated = await runCli(repoDir, ["update", backlogIssue[0].id, "--status", "backlog"]);
    expect(updated.exitCode).toBe(0);

    const ready = await runJson<Array<{ id: string; status: string }>>(repoDir, ["ready"]);
    expect(ready.map((issue) => issue.id)).toContain(readyIssue[0].id);
    expect(ready.map((issue) => issue.id)).not.toContain(backlogIssue[0].id);

    const shown = await runJson<Array<{ id: string; status: string }>>(repoDir, [
      "list",
      "--status",
      "backlog",
    ]);
    expect(shown.map((issue) => issue.id)).toContain(backlogIssue[0].id);
    expect(shown.every((issue) => issue.status === "backlog")).toBe(true);
  });

  test("ready excludes open descendants of backlog parents", async () => {
    const repoDir = createRepo();
    const parent = await runJson<Array<{ id: string }>>(repoDir, ["create", "Backlog umbrella"]);
    const child = await runJson<Array<{ id: string }>>(repoDir, [
      "create",
      "Queued child",
      "--parent",
      parent[0].id,
    ]);
    const grandchild = await runJson<Array<{ id: string }>>(repoDir, [
      "create",
      "Nested queued child",
      "--parent",
      child[0].id,
    ]);

    const updatedParent = await runCli(repoDir, ["update", parent[0].id, "--status", "backlog"]);
    expect(updatedParent.exitCode).toBe(0);

    const ready = await runJson<Array<{ id: string; status: string }>>(repoDir, ["ready"]);
    expect(ready.map((issue) => issue.id)).not.toContain(parent[0].id);
    expect(ready.map((issue) => issue.id)).not.toContain(child[0].id);
    expect(ready.map((issue) => issue.id)).not.toContain(grandchild[0].id);

    const listed = await runJson<Array<{ id: string; status: string }>>(repoDir, [
      "list",
      "--status",
      "open",
    ]);
    expect(listed.map((issue) => issue.id)).toContain(child[0].id);
    expect(listed.map((issue) => issue.id)).toContain(grandchild[0].id);
  });
});
