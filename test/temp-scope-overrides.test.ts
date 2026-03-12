import { Database } from "bun:sqlite";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { GraphQLClient } from "graphql-request";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const RUN_LINEAR_INTEGRATION_TESTS = process.env.LB_RUN_INTEGRATION_TESTS === "1";
const describeLinearSuite = RUN_LINEAR_INTEGRATION_TESTS ? describe : describe.skip;

const API_KEY = process.env.LINEAR_API_KEY;
const TEAM_KEY = process.env.LB_TEAM_KEY || "LIN";
const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const TEST_PREFIX = `[temp-scope-${Date.now()}]`;

if (RUN_LINEAR_INTEGRATION_TESTS && !API_KEY) {
  throw new Error("LINEAR_API_KEY environment variable is required for temp scope tests");
}

const client = RUN_LINEAR_INTEGRATION_TESTS
  ? new GraphQLClient("https://api.linear.app/graphql", {
      headers: { Authorization: API_KEY },
    })
  : null;

const tempDirs: string[] = [];
const issueUuids = new Set<string>();

type IssueSnapshot = {
  id: string;
  identifier: string;
  projectName: string | null;
  labels: string[];
};

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
    throw new Error(`Failed to initialize git repo: ${stderr}`);
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

async function lb(
  cwd: string,
  args: string[],
  envOverrides?: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      LB_TEAM_KEY: TEAM_KEY,
      ...(envOverrides || {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

async function lbJson<T>(
  cwd: string,
  args: string[],
  envOverrides?: Record<string, string>
): Promise<T> {
  const result = await lb(cwd, [...args, "--json"], envOverrides);
  if (result.exitCode !== 0) {
    throw new Error(
      `lb ${args.join(" ")} failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`
    );
  }
  return JSON.parse(result.stdout) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLinearIdentifier(repoDir: string, localId: string): string | null {
  try {
    const db = new Database(join(repoDir, ".lb", "cache.db"), { readonly: true });
    try {
      const row = db
        .query("SELECT linear_identifier FROM issues WHERE local_id = ? LIMIT 1")
        .get(localId) as { linear_identifier: string | null } | null;
      const identifier = row?.linear_identifier;
      return identifier && identifier.trim().length > 0 ? identifier : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function waitForLinearIdentifier(
  repoDir: string,
  localId: string,
  timeoutMs: number = 30000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const identifier = readLinearIdentifier(repoDir, localId);
    if (identifier) {
      return identifier;
    }
    await sleep(300);
  }

  throw new Error(`Timed out waiting for remote identifier for ${localId}`);
}

async function getIssueSnapshot(issueId: string): Promise<IssueSnapshot | null> {
  if (!client) {
    throw new Error("temp scope integration tests are disabled");
  }
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

async function trackIssue(issueId: string): Promise<void> {
  const snapshot = await getIssueSnapshot(issueId);
  if (snapshot) {
    issueUuids.add(snapshot.id);
  }
}

afterAll(async () => {
  if (!client) {
    return;
  }

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
      // best effort cleanup
    }
  }

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describeLinearSuite("temporary scope overrides", () => {
  test("applies --temp-name and --temp-name-mode=label for one-off scoping", async () => {
    const repoDir = createTempGitRepo("lb-temp-flag-label");
    writeRepoConfig(repoDir, {
      repo_name: `base-${Date.now()}`,
      repo_scope: "project",
    });

    const tempName = `tmp-flag-label-${Date.now()}`;
    const tempLabel = `repo:${tempName}`;

    const created = await lbJson<Array<{ id: string }>>(repoDir, [
      "--temp-name",
      tempName,
      "--temp-name-mode",
      "label",
      "create",
      `${TEST_PREFIX} flag-label`,
      "--sync",
    ]);

    const issueId = created[0].id;
    await trackIssue(issueId);

    const snapshot = await getIssueSnapshot(issueId);
    expect(snapshot).toBeTruthy();
    expect(snapshot?.labels).toContain(tempLabel);
    expect(snapshot?.projectName).not.toBe(tempName);
  });

  test("applies env temp overrides without touching repo config", async () => {
    const repoDir = createTempGitRepo("lb-temp-env-project");
    writeRepoConfig(repoDir, {
      repo_name: `base-${Date.now()}`,
      repo_scope: "label",
    });

    const tempName = `tmp-env-project-${Date.now()}`;

    const created = await lbJson<Array<{ id: string }>>(
      repoDir,
      ["create", `${TEST_PREFIX} env-project`, "--sync"],
      {
        LB_TEMP_NAME: tempName,
        LB_TEMP_NAME_MODE: "project",
      }
    );

    const issueId = created[0].id;
    await trackIssue(issueId);

    const snapshot = await getIssueSnapshot(issueId);
    expect(snapshot).toBeTruthy();
    expect(snapshot?.projectName).toBe(tempName);
  });

  test("CLI temp flags take precedence over env temp overrides", async () => {
    const repoDir = createTempGitRepo("lb-temp-precedence");
    writeRepoConfig(repoDir, {
      repo_name: `base-${Date.now()}`,
      repo_scope: "label",
    });

    const envName = `tmp-env-${Date.now()}`;
    const cliName = `tmp-cli-${Date.now()}`;

    const created = await lbJson<Array<{ id: string }>>(
      repoDir,
      ["--temp-name", cliName, "--temp-name-mode", "project", "create", ` precedence`, "--sync"],
      {
        LB_TEMP_NAME: envName,
        LB_TEMP_NAME_MODE: "label",
      }
    );

    const issueId = created[0].id;
    await trackIssue(issueId);

    const snapshot = await getIssueSnapshot(issueId);
    expect(snapshot).toBeTruthy();
    expect(snapshot?.projectName).toBe(cliName);
    expect(snapshot?.labels).not.toContain(`repo:${envName}`);
  });

  test("queued create with CLI temp flags preserves scope in spawned worker", async () => {
    const repoDir = createTempGitRepo("lb-temp-worker-propagation");
    const baseName = `base-${Date.now()}`;
    writeRepoConfig(repoDir, {
      repo_name: baseName,
      repo_scope: "label",
    });

    const tempName = `tmp-worker-project-${Date.now()}`;
    const created = await lbJson<Array<{ id: string }>>(repoDir, [
      "--temp-name",
      tempName,
      "--temp-name-mode",
      "project",
      "create",
      `${TEST_PREFIX} queued-worker`,
    ]);

    const localId = created[0].id;
    expect(localId.startsWith("LOCAL-")).toBe(true);

    const remoteIdentifier = await waitForLinearIdentifier(repoDir, localId);
    await trackIssue(remoteIdentifier);

    const snapshot = await getIssueSnapshot(remoteIdentifier);
    expect(snapshot).toBeTruthy();
    expect(snapshot?.projectName).toBe(tempName);
    expect(snapshot?.labels).not.toContain(`repo:${baseName}`);
  });
});
