#!/usr/bin/env bun

import { GraphQLClient } from "graphql-request";
import { basename, join } from "path";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";

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

type IssueSnapshot = {
  id: string;
  identifier: string;
  projectName: string | null;
  labels: string[];
};

const tempDirs: string[] = [];
const issueUuids = new Set<string>();

function createTempGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  tempDirs.push(dir);

  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (init.exitCode !== 0) {
    const stderr = init.stderr ? Buffer.from(init.stderr).toString("utf8") : "";
    throw new Error(`git init failed: ${stderr}`);
  }

  return dir;
}

function writeRepoConfig(
  repoDir: string,
  config: { repo_name: string; repo_scope: "label" | "project" | "both" }
): void {
  const lbDir = join(repoDir, ".lb");
  mkdirSync(lbDir, { recursive: true });
  writeFileSync(join(lbDir, "config.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
}

function readRepoConfig(repoDir: string): { repo_name?: string; repo_scope?: string } {
  const configPath = join(repoDir, ".lb", "config.jsonc");
  if (!existsSync(configPath)) {
    throw new Error(`Missing repo config at ${configPath}`);
  }
  return JSON.parse(readFileSync(configPath, "utf8"));
}

async function lb(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      LB_TEAM_KEY: TEAM_KEY,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

async function lbJson<T>(cwd: string, ...args: string[]): Promise<T> {
  const result = await lb(cwd, ...args, "--json");
  if (result.exitCode !== 0) {
    throw new Error(`lb ${args.join(" ")} failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return JSON.parse(result.stdout) as T;
}

async function mustSucceed(cwd: string, ...args: string[]): Promise<string> {
  const result = await lb(cwd, ...args);
  if (result.exitCode !== 0) {
    throw new Error(`lb ${args.join(" ")} failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return result.stdout;
}

async function getIssueSnapshot(issueId: string): Promise<IssueSnapshot | null> {
  const result = await client.request<{
    issue: {
      id: string;
      identifier: string;
      project: { name: string } | null;
      labels: { nodes: Array<{ name: string }> };
    } | null;
  }>(
    `query IssueSnapshot($id: String!) {
      issue(id: $id) {
        id
        identifier
        project {
          name
        }
        labels {
          nodes {
            name
          }
        }
      }
    }`,
    { id: issueId }
  );

  if (!result.issue) {
    return null;
  }

  return {
    id: result.issue.id,
    identifier: result.issue.identifier,
    projectName: result.issue.project?.name || null,
    labels: result.issue.labels.nodes.map((node) => node.name),
  };
}

async function waitForIssue(
  issueId: string,
  predicate: (snapshot: IssueSnapshot) => boolean,
  label: string
): Promise<IssueSnapshot> {
  const deadline = Date.now() + 30000;
  let last: IssueSnapshot | null = null;

  while (Date.now() < deadline) {
    last = await getIssueSnapshot(issueId);
    if (last && predicate(last)) {
      return last;
    }
    await Bun.sleep(500);
  }

  throw new Error(`Timed out waiting for ${label} on ${issueId}; last=${JSON.stringify(last)}`);
}

async function cleanup(): Promise<void> {
  for (const issueId of issueUuids) {
    try {
      await client.request(
        `mutation DeleteIssue($id: String!) {
          issueDelete(id: $id) {
            success
          }
        }`,
        { id: issueId }
      );
    } catch {
      // Best effort cleanup.
    }
  }

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  console.log("Smoke 1/2: first init defaults to project scope...");
  const initRepo = createTempGitRepo("lb-smoke-init-default");
  await mustSucceed(initRepo, "init");

  const initConfig = readRepoConfig(initRepo);
  assert(initConfig.repo_scope === "project", `expected repo_scope=project, got ${initConfig.repo_scope}`);
  assert(initConfig.repo_name === basename(initRepo), "expected init repo_name to match directory name");

  console.log("Smoke 2/2: migrate + rebind flow...");
  const migrationRepo = createTempGitRepo("lb-smoke-migrate-rebind");
  const sourceName = `smoke-src-${Date.now()}`;
  const projectName = `smoke-project-${Date.now()}`;
  const configOnlyName = `smoke-config-only-${Date.now()}`;
  const sourceLabel = `repo:${sourceName}`;
  const configOnlyLabel = `repo:${configOnlyName}`;

  writeRepoConfig(migrationRepo, {
    repo_name: sourceName,
    repo_scope: "label",
  });

  await mustSucceed(migrationRepo, "init", "--force");

  const createdA = await lbJson<Array<{ id: string }>>(
    migrationRepo,
    "create",
    `[smoke-${Date.now()}] migrate-default`,
    "--sync"
  );
  const issueA = createdA[0].id;
  const issueASnapshot = await getIssueSnapshot(issueA);
  if (issueASnapshot) issueUuids.add(issueASnapshot.id);

  await mustSucceed(migrationRepo, "migrate", "to-project");

  await waitForIssue(
    issueA,
    (snapshot) => snapshot.projectName === sourceName && !snapshot.labels.includes(sourceLabel),
    "migrate default move"
  );

  await mustSucceed(migrationRepo, "rebind", "--to-name", projectName, "--to-scope", "project");

  await waitForIssue(
    issueA,
    (snapshot) => snapshot.projectName === projectName,
    "rebind to project scope"
  );

  const createdB = await lbJson<Array<{ id: string }>>(
    migrationRepo,
    "create",
    `[smoke-${Date.now()}] rebind-config-only`,
    "--sync"
  );
  const issueB = createdB[0].id;
  const issueBSnapshot = await getIssueSnapshot(issueB);
  if (issueBSnapshot) issueUuids.add(issueBSnapshot.id);

  await mustSucceed(
    migrationRepo,
    "rebind",
    "--to-name",
    configOnlyName,
    "--to-scope",
    "label",
    "--config-only"
  );

  const configOnlyIssue = await waitForIssue(
    issueB,
    (snapshot) => snapshot.projectName === projectName,
    "config-only preserves issue binding"
  );

  assert(
    !configOnlyIssue.labels.includes(configOnlyLabel),
    "config-only should not add target label to existing issues"
  );

  const finalConfig = readRepoConfig(migrationRepo);
  assert(finalConfig.repo_name === configOnlyName, "expected config-only rebind to update repo_name");
  assert(finalConfig.repo_scope === "label", "expected config-only rebind to update repo_scope");

  console.log("Smoke completed successfully.");
  console.log(`- init default verified in: ${initRepo}`);
  console.log(`- migrate/rebind flow verified in: ${migrationRepo}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
