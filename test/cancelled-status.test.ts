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
  const repoDir = mkdtempSync(join(tmpdir(), "lb-cancelled-status-"));
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

describe("cancelled status support", () => {
  test("maps cancelled cleanly to and from Linear workflow state types", () => {
    expect(statusToLinearState("cancelled")).toBe("canceled");
    expect(linearStateToStatus("canceled")).toBe("cancelled");
    expect(linearStateToStatus("completed")).toBe("closed");
  });

  test("update accepts canceled aliases and stores canonical cancelled output", async () => {
    const repoDir = createRepo();
    const created = await runJson<Array<{ id: string }>>(repoDir, ["create", "Alias test"]);

    const updated = await runJson<Array<{ id: string; status: string; closed_at?: string }>>(
      repoDir,
      ["update", created[0].id, "--status", "canceled"]
    );

    expect(updated[0]?.status).toBe("cancelled");
    expect(updated[0]?.closed_at).toBeTruthy();

    const listed = await runJson<Array<{ id: string; status: string }>>(repoDir, [
      "list",
      "--status",
      "cancelled",
    ]);
    expect(listed.map((issue) => issue.id)).toContain(created[0].id);
    expect(listed[0]?.status).toBe("cancelled");
  });

  test("cancel command marks issues cancelled and keeps close for completed work", async () => {
    const repoDir = createRepo();
    const created = await runJson<Array<{ id: string }>>(repoDir, ["create", "Cancel me"]);

    const cancelled = await runJson<Array<{ id: string; status: string }>>(repoDir, [
      "cancel",
      created[0].id,
    ]);
    expect(cancelled[0]?.status).toBe("cancelled");

    const shown = await runJson<Array<{ id: string; status: string }>>(repoDir, [
      "show",
      created[0].id,
    ]);
    expect(shown[0]?.status).toBe("cancelled");
  });

  test("ready excludes cancelled issues and cancelled blockers stop blocking work", async () => {
    const repoDir = createRepo();
    const blocker = await runJson<Array<{ id: string }>>(repoDir, ["create", "Blocker"]);
    const blocked = await runJson<Array<{ id: string }>>(repoDir, ["create", "Blocked"]);

    const dep = await runCli(repoDir, ["dep", "add", blocked[0].id, "--blocked-by", blocker[0].id]);
    expect(dep.exitCode).toBe(0);

    const initiallyReady = await runJson<Array<{ id: string }>>(repoDir, ["ready"]);
    expect(initiallyReady.map((issue) => issue.id)).toContain(blocker[0].id);
    expect(initiallyReady.map((issue) => issue.id)).not.toContain(blocked[0].id);

    const cancelled = await runCli(repoDir, ["cancel", blocker[0].id]);
    expect(cancelled.exitCode).toBe(0);

    const readyAfterCancel = await runJson<Array<{ id: string; status: string }>>(repoDir, ["ready"]);
    expect(readyAfterCancel.map((issue) => issue.id)).toContain(blocked[0].id);
    expect(readyAfterCancel.map((issue) => issue.id)).not.toContain(blocker[0].id);
    expect(readyAfterCancel.every((issue) => issue.status !== "cancelled")).toBe(true);
  });
});
