import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { GraphQLClient } from "graphql-request";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { Database } from "bun:sqlite";

const RUN_LINEAR_INTEGRATION_TESTS = process.env.LB_RUN_INTEGRATION_TESTS === "1";
const describeLinearSuite = RUN_LINEAR_INTEGRATION_TESTS ? describe : describe.skip;

const TEAM_KEY = process.env.LB_TEAM_KEY || "LIN";
const API_KEY = process.env.LINEAR_API_KEY;
const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const TEST_PREFIX = `[repo-binding-${Date.now()}]`;

if (RUN_LINEAR_INTEGRATION_TESTS && !API_KEY) {
  throw new Error(
    "LINEAR_API_KEY environment variable is required for repo binding integration tests"
  );
}

const client = RUN_LINEAR_INTEGRATION_TESTS
  ? new GraphQLClient("https://api.linear.app/graphql", {
      headers: { Authorization: API_KEY },
    })
  : null;

setDefaultTimeout(30000);

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

function readRepoConfig(repoDir: string): {
  repo_name?: string;
  repo_scope?: string;
  repo_binding_version?: number;
} {
  const configPath = join(repoDir, ".lb", "config.jsonc");
  if (!existsSync(configPath)) {
    throw new Error(`Config file missing: ${configPath}`);
  }
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function seedLegacyLocalState(repoDir: string): void {
  const lbDir = join(repoDir, ".lb");
  mkdirSync(lbDir, { recursive: true });
  const db = new Database(join(lbDir, "cache.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.query(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync', datetime('now'))"
  ).run();
  db.close();
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
    throw new Error(
      `lb ${args.join(" ")} failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`
    );
  }
  return JSON.parse(result.stdout) as T;
}

async function getIssueSnapshot(issueId: string): Promise<IssueSnapshot | null> {
  if (!client) {
    throw new Error("repo binding integration tests are disabled");
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

async function waitForIssueState(
  issueId: string,
  predicate: (snapshot: IssueSnapshot) => boolean,
  message: string
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

  throw new Error(
    `Timed out waiting for issue state (${message}) for ${issueId}. Last snapshot: ${JSON.stringify(last)}`
  );
}

async function mustSucceed(cwd: string, ...args: string[]): Promise<string> {
  const result = await lb(cwd, ...args);
  if (result.exitCode !== 0) {
    throw new Error(
      `lb ${args.join(" ")} failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`
    );
  }
  return result.stdout;
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
      // Best-effort cleanup only.
    }
  }

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describeLinearSuite("repo binding flows", () => {
  test("init defaults new repos to label scope", async () => {
    const repoDir = createTempGitRepo("lb-init-label-default");

    await mustSucceed(repoDir, "init");

    const config = readRepoConfig(repoDir);
    expect(config.repo_binding_version).toBe(1);
    expect(config.repo_scope).toBeUndefined();
    expect(typeof config.repo_name).toBe("string");
    expect(config.repo_name).toBe(basename(repoDir));
  });

  test("init bootstraps missing config even when .lb exists", async () => {
    const repoDir = createTempGitRepo("lb-init-bootstrap-missing-config");
    mkdirSync(join(repoDir, ".lb"), { recursive: true });

    await mustSucceed(repoDir, "init");

    const config = readRepoConfig(repoDir);
    expect(config.repo_binding_version).toBe(1);
    expect(config.repo_scope).toBeUndefined();
  });

  test("init keeps legacy default when local cache has prior state", async () => {
    const repoDir = createTempGitRepo("lb-init-legacy-local-state");
    seedLegacyLocalState(repoDir);

    await mustSucceed(repoDir, "init");

    const config = readRepoConfig(repoDir);
    expect(config.repo_binding_version).toBe(1);
    expect(config.repo_scope).toBeUndefined();
  });

  test("init preserves explicit existing label scope config", async () => {
    const repoDir = createTempGitRepo("lb-init-preserve-config");
    const repoName = `rb-preserve-${Date.now()}`;

    writeRepoConfig(repoDir, {
      repo_name: repoName,
      repo_scope: "label",
    });

    await mustSucceed(repoDir, "init", "--force");

    const config = readRepoConfig(repoDir);
    expect(config.repo_name).toBe(repoName);
    expect(config.repo_scope).toBe("label");
  });

  test("migrate to-project removes repo label by default and keep-label preserves it", async () => {
    const repoDir = createTempGitRepo("lb-migrate-to-project");
    const repoName = `rb-migrate-${Date.now()}`;
    const repoLabel = `repo:${repoName}`;

    writeRepoConfig(repoDir, {
      repo_name: repoName,
      repo_scope: "label",
    });

    await mustSucceed(repoDir, "init", "--force");

    const createdA = await lbJson<Array<{ id: string }>>(
      repoDir,
      "create",
      `${TEST_PREFIX} migrate-default-a`,
      "--sync"
    );
    const issueA = createdA[0].id;
    await trackIssue(issueA);

    await mustSucceed(repoDir, "migrate", "to-project");

    const migratedA = await waitForIssueState(
      issueA,
      (snapshot) => snapshot.projectName === repoName && !snapshot.labels.includes(repoLabel),
      "default migration should move and remove label"
    );

    expect(migratedA.projectName).toBe(repoName);
    expect(migratedA.labels).not.toContain(repoLabel);

    const createdB = await lbJson<Array<{ id: string }>>(
      repoDir,
      "create",
      `${TEST_PREFIX} migrate-keep-label-b`,
      "--sync"
    );
    const issueB = createdB[0].id;
    await trackIssue(issueB);

    await mustSucceed(repoDir, "migrate", "to-project", "--keep-label");

    const migratedB = await waitForIssueState(
      issueB,
      (snapshot) => snapshot.projectName === repoName && snapshot.labels.includes(repoLabel),
      "keep-label migration should keep label"
    );

    expect(migratedB.projectName).toBe(repoName);
    expect(migratedB.labels).toContain(repoLabel);
  });

  test("rebind moves issues by default and config-only skips issue migration", async () => {
    const repoDir = createTempGitRepo("lb-rebind");
    const sourceName = `rb-src-${Date.now()}`;
    const targetProjectName = `rb-project-${Date.now()}`;
    const configOnlyName = `rb-config-only-${Date.now()}`;
    const sourceLabel = `repo:${sourceName}`;
    const configOnlyLabel = `repo:${configOnlyName}`;

    writeRepoConfig(repoDir, {
      repo_name: sourceName,
      repo_scope: "label",
    });

    await mustSucceed(repoDir, "init", "--force");

    const createdA = await lbJson<Array<{ id: string }>>(
      repoDir,
      "create",
      `${TEST_PREFIX} rebind-default-a`,
      "--sync"
    );
    const issueA = createdA[0].id;
    await trackIssue(issueA);

    // Ensure source issues are project-only first to validate default source-scope behavior.
    await mustSucceed(repoDir, "migrate", "to-project");

    await mustSucceed(repoDir, "rebind", "--to-name", targetProjectName, "--to-scope", "project");

    const reboundA = await waitForIssueState(
      issueA,
      (snapshot) =>
        snapshot.projectName === targetProjectName && !snapshot.labels.includes(sourceLabel),
      "default rebind should move issue to project and clear source label"
    );

    expect(reboundA.projectName).toBe(targetProjectName);
    expect(reboundA.labels).not.toContain(sourceLabel);

    const configAfterRebind = readRepoConfig(repoDir);
    expect(configAfterRebind.repo_name).toBe(targetProjectName);
    expect(configAfterRebind.repo_scope).toBe("project");

    const createdB = await lbJson<Array<{ id: string }>>(
      repoDir,
      "create",
      `${TEST_PREFIX} rebind-config-only-b`,
      "--sync"
    );
    const issueB = createdB[0].id;
    await trackIssue(issueB);

    await mustSucceed(
      repoDir,
      "rebind",
      "--to-name",
      configOnlyName,
      "--to-scope",
      "label",
      "--config-only"
    );

    const postConfigOnly = await waitForIssueState(
      issueB,
      (snapshot) => snapshot.projectName === targetProjectName,
      "config-only should leave issue binding unchanged"
    );

    expect(postConfigOnly.projectName).toBe(targetProjectName);
    expect(postConfigOnly.labels).not.toContain(configOnlyLabel);

    const configAfterConfigOnly = readRepoConfig(repoDir);
    expect(configAfterConfigOnly.repo_name).toBe(configOnlyName);
    expect(configAfterConfigOnly.repo_scope).toBe("label");
  });
});
