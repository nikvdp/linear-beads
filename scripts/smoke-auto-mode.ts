#!/usr/bin/env bun

import { GraphQLClient } from "graphql-request";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentRun } from "../src/types.js";

const API_KEY = process.env.LINEAR_API_KEY;
const TEAM_KEY = process.env.LB_TEAM_KEY || "LIN";
const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

if (!API_KEY) {
  console.error("LINEAR_API_KEY is required");
  process.exit(1);
}

const client = new GraphQLClient("https://api.linear.app/graphql", {
  headers: { Authorization: API_KEY },
});
const issueIds = new Set<string>();
const labelNames = new Set<string>();
const tempDirs: string[] = [];
const spawnedPids = new Set<number>();
let teamIdForCleanup: string | null = null;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function step(name: string, operation: () => Promise<void>): Promise<void> {
  process.stdout.write(`${name}... `);
  try {
    await operation();
    console.log("PASS");
  } catch (error) {
    console.log("FAIL");
    throw error;
  }
}

function git(repo: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "lb smoke",
      GIT_AUTHOR_EMAIL: "lb-smoke@example.com",
      GIT_COMMITTER_NAME: "lb smoke",
      GIT_COMMITTER_EMAIL: "lb-smoke@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function createDaemonRepo(config: Record<string, unknown>): string {
  const repo = mkdtempSync(join(tmpdir(), "lb-auto-smoke-"));
  tempDirs.push(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "README.md"), "auto smoke fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "fixture");
  mkdirSync(join(repo, ".lb"), { recursive: true });
  writeFileSync(join(repo, ".lb", "config.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
  return repo;
}

async function lb(
  cwd: string,
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, LB_TEAM_KEY: TEAM_KEY, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

async function mustLb(cwd: string, args: string[], env: Record<string, string>): Promise<string> {
  const result = await lb(cwd, args, env);
  if (result.exitCode !== 0) {
    throw new Error(
      `lb ${args.join(" ")} failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`
    );
  }
  return result.stdout;
}

async function addLabel(issueId: string, labelId: string): Promise<void> {
  const current = await client.request<{
    issue: { id: string; labels: { nodes: Array<{ id: string }> } } | null;
  }>(
    `query SmokeIssueLabels($id: String!) {
      issue(id: $id) { id labels { nodes { id } } }
    }`,
    { id: issueId }
  );
  if (!current.issue) throw new Error(`Issue not found: ${issueId}`);
  const labelIds = [...new Set([...current.issue.labels.nodes.map((label) => label.id), labelId])];
  const updated = await client.request<{ issueUpdate: { success: boolean } }>(
    `mutation SmokeAddLabel($id: String!, $labelIds: [String!]!) {
      issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
    }`,
    { id: current.issue.id, labelIds }
  );
  assert(updated.issueUpdate.success, `Failed to label ${issueId}`);
}

async function getClaimSnapshot(issueId: string): Promise<{
  stateType: string;
  assigneeId: string | null;
  comments: string[];
}> {
  const result = await client.request<{
    issue: {
      state: { type: string };
      assignee: { id: string } | null;
      comments: { nodes: Array<{ body: string }> };
    } | null;
  }>(
    `query SmokeClaimSnapshot($id: String!) {
      issue(id: $id) {
        state { type }
        assignee { id }
        comments(first: 50) { nodes { body } }
      }
    }`,
    { id: issueId }
  );
  if (!result.issue) throw new Error(`Issue not found: ${issueId}`);
  return {
    stateType: result.issue.state.type,
    assigneeId: result.issue.assignee?.id || null,
    comments: result.issue.comments.nodes.map((comment) => comment.body),
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && processAlive(pid)) await Bun.sleep(100);
  assert(!processAlive(pid), `Stub agent pid ${pid} did not exit`);
}

async function cleanupLabels(): Promise<void> {
  if (!teamIdForCleanup || labelNames.size === 0) return;
  const labels: Array<{ id: string; name: string }> = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const result = await client.request<{
      team: {
        labels: {
          nodes: Array<{ id: string; name: string }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    }>(
      `query SmokeCleanupLabels($teamId: String!, $cursor: String) {
        team(id: $teamId) {
          labels(first: 50, after: $cursor) {
            nodes { id name }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { teamId: teamIdForCleanup, cursor }
    );
    labels.push(...result.team.labels.nodes);
    hasNextPage = result.team.labels.pageInfo.hasNextPage;
    cursor = result.team.labels.pageInfo.endCursor;
  }
  for (const label of labels.filter((entry) => labelNames.has(entry.name))) {
    try {
      await client.request(
        `mutation SmokeDeleteLabel($id: String!) {
          issueLabelDelete(id: $id) { success }
        }`,
        { id: label.id }
      );
    } catch {
      // Best effort cleanup.
    }
  }
}

async function cleanup(): Promise<void> {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The short-lived stub normally exits first.
    }
  }
  for (const issueId of issueIds) {
    try {
      await client.request(
        `mutation SmokeDeleteIssue($id: String!) {
          issueDelete(id: $id) { success }
        }`,
        { id: issueId }
      );
    } catch {
      // Best effort cleanup.
    }
  }
  try {
    await cleanupLabels();
  } catch {
    // Best effort cleanup.
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pullScope = `auto-smoke-pull-${stamp}`;
  const daemonScope = `auto-smoke-daemon-${stamp}`;
  const autoLabel = `auto-smoke-${stamp}`;
  labelNames.add(autoLabel);
  labelNames.add(`repo:${pullScope}`);
  labelNames.add(`repo:${daemonScope}`);

  process.env.LB_TEMP_NAME = pullScope;
  process.env.LB_TEMP_NAME_MODE = "label";
  const { setRuntimeOverrides } = await import("../src/utils/config.js");
  const { ClaimLostError, claimAutoIssue, ensureAutoLabel, fetchClaimableAutoIssues } =
    await import("../src/utils/auto.js");
  const { createIssue, createRelation, deleteRelation, getTeamId } =
    await import("../src/utils/linear.js");

  setRuntimeOverrides({ repo_name: pullScope, repo_scope: "label", auto_label: autoLabel });
  const teamId = await getTeamId(TEAM_KEY);
  teamIdForCleanup = teamId;
  const autoLabelId = await ensureAutoLabel(teamId);
  let pullIssue: Awaited<ReturnType<typeof createIssue>> | undefined;

  await step("1/5 create and discover auto work", async () => {
    pullIssue = await createIssue({
      title: `[auto-smoke ${stamp}] pull candidate`,
      priority: 2,
      teamId,
    });
    issueIds.add(pullIssue.id);
    await addLabel(pullIssue.id, autoLabelId);
    const candidates = await fetchClaimableAutoIssues(teamId);
    assert(candidates.some((issue) => issue.id === pullIssue.id), "Auto issue was not discovered");
  });
  assert(pullIssue, "Pull issue was not created");
  const claimCandidate = pullIssue;

  await step("2/5 enforce blocker readiness", async () => {
    const blocker = await createIssue({
      title: `[auto-smoke ${stamp}] blocker`,
      priority: 2,
      teamId,
    });
    issueIds.add(blocker.id);
    await createRelation(blocker.id, claimCandidate.id, "blocks");
    const blockedCandidates = await fetchClaimableAutoIssues(teamId);
    assert(
      !blockedCandidates.some((issue) => issue.id === claimCandidate.id),
      "Blocked issue remained claimable"
    );
    await deleteRelation(blocker.id, claimCandidate.id, "blocks");
    const readyAgain = await fetchClaimableAutoIssues(teamId);
    assert(
      readyAgain.some((issue) => issue.id === claimCandidate.id),
      "Unblocked issue stayed hidden"
    );
  });

  await step("3/5 claim synchronously and reject a second claim", async () => {
    const runId = `run-smoke-${stamp}`;
    await claimAutoIssue(claimCandidate, { runId });
    const snapshot = await getClaimSnapshot(claimCandidate.id);
    assert(snapshot.stateType === "started", `Expected started state, got ${snapshot.stateType}`);
    assert(snapshot.assigneeId, "Claim did not assign the Linear viewer");
    assert(
      snapshot.comments.some((comment) => comment.includes(`(run ${runId})`)),
      "Claim comment was not posted"
    );
    let lost = false;
    try {
      await claimAutoIssue(claimCandidate, { runId: `${runId}-again` });
    } catch (error) {
      lost = error instanceof ClaimLostError;
    }
    assert(lost, "Second claim did not throw ClaimLostError");
  });

  await step("4/5 spawn and flag an exited stub agent", async () => {
    setRuntimeOverrides({ repo_name: daemonScope, repo_scope: "label", auto_label: autoLabel });
    const daemonIssue = await createIssue({
      title: `[auto-smoke ${stamp}] daemon candidate`,
      priority: 2,
      teamId,
    });
    issueIds.add(daemonIssue.id);
    await addLabel(daemonIssue.id, autoLabelId);

    const repo = createDaemonRepo({
      repo_name: daemonScope,
      repo_scope: "label",
      repo_binding_version: 1,
      auto_label: autoLabel,
      auto_agent: "stub",
      auto_agents: { stub: "sleep 1" },
    });
    const env = { LB_TEMP_NAME: daemonScope, LB_TEMP_NAME_MODE: "label" };
    await mustLb(repo, ["auto", "run", "--agent-name", "stub", "--once"], env);
    const running = JSON.parse(await mustLb(repo, ["auto", "ps", "--all", "--json"], env)) as
      AgentRun[];
    assert(running.length === 1, `Expected one run row, got ${running.length}`);
    assert(running[0].status === "running", `Expected running row, got ${running[0].status}`);
    assert(running[0].pid !== undefined, "Run row did not record a pid");
    spawnedPids.add(running[0].pid);
    assert(
      existsSync(join(repo, ".worktrees", running[0].id)),
      "Daemon did not create the run worktree"
    );

    await waitForExit(running[0].pid);
    spawnedPids.delete(running[0].pid);
    await mustLb(repo, ["auto", "run", "--agent-name", "stub", "--once"], env);
    const reaped = JSON.parse(await mustLb(repo, ["auto", "ps", "--all", "--json"], env)) as
      AgentRun[];
    assert(reaped[0].status === "flagged", `Expected flagged row, got ${reaped[0].status}`);
  });

  await step("5/5 cleanup scratch state", async () => {
    await cleanup();
  });
  console.log("Auto mode smoke completed successfully.");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
