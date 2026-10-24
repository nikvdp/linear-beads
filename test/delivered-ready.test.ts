/**
 * test/delivered-ready — lb deliver + ready delivery-evidence filter (MG-1207)
 *
 * Beads delivered via a merged PR but never transitioned used to pollute
 * `lb ready` forever — status alone carried no delivery signal. `lb deliver`
 * records canonical marker evidence; ready views exclude it; `lb ready
 * --delivered` surfaces it so curation can advance status.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildDeliveredCommentBody,
  DELIVERED_MARKER,
  isDeliveredCommentBody,
} from "../src/utils/delivered.js";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-delivered-ready-"));
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

async function runCli(
  cwd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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

describe("delivered marker helpers", () => {
  test("builds marker-only body with no extras", () => {
    expect(buildDeliveredCommentBody({})).toBe(DELIVERED_MARKER);
  });

  test("includes pr url and note when provided", () => {
    const body = buildDeliveredCommentBody({
      prUrl: "https://github.com/org/repo/pull/42",
      note: "shipped in release 2026-10-01",
    });
    expect(body).toContain(DELIVERED_MARKER);
    expect(body).toContain("pr=https://github.com/org/repo/pull/42");
    expect(body).toContain("shipped in release 2026-10-01");
  });

  test("recognizes marker bodies, rejects prose", () => {
    expect(isDeliveredCommentBody(DELIVERED_MARKER)).toBe(true);
    expect(isDeliveredCommentBody(`prefix\n${DELIVERED_MARKER}\npr=x`)).toBe(true);
    expect(isDeliveredCommentBody("delivered via PR #96 (merged)")).toBe(false);
  });
});

describe("lb deliver + ready filter (MG-1207)", () => {
  test("ready excludes delivered issues and includes unmarked ones", async () => {
    const repoDir = createRepo();
    const stale = await runJson<Array<{ id: string }>>(repoDir, ["create", "Delivered work"]);
    const fresh = await runJson<Array<{ id: string }>>(repoDir, ["create", "Real open work"]);

    const delivered = await runJson<{ delivered: boolean; already_recorded: boolean }>(repoDir, [
      "deliver",
      stale[0].id,
    ]);
    expect(delivered.delivered).toBe(true);
    expect(delivered.already_recorded).toBe(false);

    const ready = await runJson<Array<{ id: string }>>(repoDir, ["ready"]);
    const readyIds = ready.map((issue) => issue.id);
    expect(readyIds).toContain(fresh[0].id);
    expect(readyIds).not.toContain(stale[0].id);
  });

  test("deliver is idempotent — second run records already_recorded, no duplicate comment", async () => {
    const repoDir = createRepo();
    const issue = await runJson<Array<{ id: string }>>(repoDir, ["create", "Once only"]);

    const first = await runJson<{ already_recorded: boolean; comment_id: string }>(repoDir, [
      "deliver",
      issue[0].id,
    ]);
    expect(first.already_recorded).toBe(false);

    const second = await runJson<{ already_recorded: boolean; comment_id: string }>(repoDir, [
      "deliver",
      issue[0].id,
    ]);
    expect(second.already_recorded).toBe(true);
    expect(second.comment_id).toBe(first.comment_id);

    const comments = await runJson<Array<{ body: string }>>(repoDir, [
      "comment",
      "list",
      issue[0].id,
    ]);
    const markerComments = comments.filter((c) => isDeliveredCommentBody(c.body));
    expect(markerComments.length).toBe(1);
  });

  test("deliver --pr stores the pull request url in the marker comment", async () => {
    const repoDir = createRepo();
    const issue = await runJson<Array<{ id: string }>>(repoDir, ["create", "PR evidence"]);

    await runCli(repoDir, [
      "deliver",
      issue[0].id,
      "--pr",
      "https://github.com/metrograph-ai/voltron/pull/96",
    ]);

    const comments = await runJson<Array<{ body: string }>>(repoDir, [
      "comment",
      "list",
      issue[0].id,
    ]);
    const marker = comments.find((c) => isDeliveredCommentBody(c.body));
    expect(marker).toBeDefined();
    expect(marker!.body).toContain("https://github.com/metrograph-ai/voltron/pull/96");
  });

  test("ready --delivered lists delivered-but-untransitioned issues", async () => {
    const repoDir = createRepo();
    const issue = await runJson<Array<{ id: string }>>(repoDir, ["create", "Needs transition"]);
    await runCli(repoDir, ["deliver", issue[0].id, "--note", "merged in #1045"]);

    const delivered = await runJson<Array<{ id: string }>>(repoDir, ["ready", "--delivered"]);
    expect(delivered.map((i) => i.id)).toContain(issue[0].id);

    const ready = await runJson<Array<{ id: string }>>(repoDir, ["ready"]);
    expect(ready.map((i) => i.id)).not.toContain(issue[0].id);
  });

  test("beads-style view excludes delivered in_progress beads", async () => {
    const repoDir = createRepo();
    const delivered = await runJson<Array<{ id: string }>>(repoDir, [
      "create",
      "Shipped but stuck in progress",
    ]);
    const active = await runJson<Array<{ id: string }>>(repoDir, ["create", "Still working"]);

    await runCli(repoDir, ["update", delivered[0].id, "--status", "in_progress"]);
    await runCli(repoDir, ["update", active[0].id, "--status", "in_progress"]);
    await runCli(repoDir, ["deliver", delivered[0].id]);

    const beads = await runCli(repoDir, ["ready", "--style", "beads"]);
    expect(beads.exitCode).toBe(0);
    expect(beads.stdout).toContain("Still working");
    expect(beads.stdout).not.toContain("Shipped but stuck in progress");
  });

  test("human output notes excluded delivered count", async () => {
    const repoDir = createRepo();
    const stale = await runJson<Array<{ id: string }>>(repoDir, ["create", "Gone but listed"]);
    await runCli(repoDir, ["deliver", stale[0].id]);

    const ready = await runCli(repoDir, ["ready"]);
    expect(ready.exitCode).toBe(0);
    expect(ready.stdout).toContain("1 delivered bead(s) excluded");
    expect(ready.stdout).toContain("lb ready --delivered");
  });

  test("closing a delivered bead clears it from ready --delivered", async () => {
    const repoDir = createRepo();
    const issue = await runJson<Array<{ id: string }>>(repoDir, ["create", "Finish it"]);
    await runCli(repoDir, ["deliver", issue[0].id]);
    await runCli(repoDir, ["close", issue[0].id]);

    const delivered = await runJson<Array<{ id: string }>>(repoDir, ["ready", "--delivered"]);
    expect(delivered.map((i) => i.id)).not.toContain(issue[0].id);
  });
});
