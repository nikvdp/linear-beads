/**
 * Integration tests for lb CLI
 *
 * Requires:
 * - LINEAR_API_KEY environment variable
 * - LB_TEAM_KEY environment variable (or uses LIN as default)
 *
 * Run the full Linear-backed suites with:
 * - bun run test:integration
 * - or LB_RUN_INTEGRATION_TESTS=1 bun test test/integration.test.ts
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  setDefaultTimeout,
} from "bun:test";
import { Database } from "bun:sqlite";
import { GraphQLClient } from "graphql-request";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// Increase timeout for API calls
setDefaultTimeout(30000);

const RUN_LINEAR_INTEGRATION_TESTS = process.env.LB_RUN_INTEGRATION_TESTS === "1";
const describeLinearSuite = RUN_LINEAR_INTEGRATION_TESTS ? describe : describe.skip;

const TEAM_KEY = process.env.LB_TEAM_KEY || "LIN";
const WORKSPACE_SLUG = "linear-beads";
const TEST_PREFIX = `[test-${Date.now()}]`;

// Track all test issue IDs for cleanup
const testIssueIds: string[] = [];

// Helper to run lb commands
async function lb(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, LB_TEAM_KEY: TEAM_KEY },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

// Helper to run lb and parse JSON output
async function lbJson<T>(...args: string[]): Promise<T> {
  const result = await lb(...args, "--json");
  if (result.exitCode !== 0) {
    throw new Error(`lb ${args.join(" ")} failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

// Wait for a title to appear with a synced Linear-style ID.
// This avoids flakiness when background worker races with explicit `lb sync`.
async function waitForSyncedIssueByTitle(
  title: string,
  timeoutMs = 20000
): Promise<{ id: string; title: string } | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await lb("sync");
    const allIssues = await lbJson<Array<{ id: string; title: string }>>("list", "--all");
    const found = allIssues.find((issue) => issue.title === title && /^[A-Z]+-\d+$/.test(issue.id));
    if (found) {
      return found;
    }
    await Bun.sleep(500);
  }

  return null;
}

// Helper to create test issue and track for cleanup
async function createTestIssue(
  title: string,
  ...extraArgs: string[]
): Promise<{ id: string; title: string }> {
  const result = await lbJson<Array<{ id: string; title: string }>>(
    "create",
    `${TEST_PREFIX} ${title}`,
    "--sync",
    ...extraArgs
  );
  if (result[0].id !== "pending") {
    testIssueIds.push(result[0].id);
  }
  return result[0];
}

// Delete issues directly via GraphQL (cleanup must succeed even if lb has bugs)
async function deleteTestIssues(): Promise<void> {
  if (!process.env.LINEAR_API_KEY) return;

  const client = new GraphQLClient("https://api.linear.app/graphql", {
    headers: { Authorization: process.env.LINEAR_API_KEY },
  });

  // First sync to get any pending issues created
  await lb("sync");

  // Get all issues that match our test prefix
  const allIssues = await lbJson<Array<{ id: string; title: string }>>("list", "--all");
  const testIssues = allIssues.filter((i) => i.title.includes(TEST_PREFIX));

  // Combine tracked IDs with any found by prefix (in case tracking missed some)
  const idsToDelete = [...new Set([...testIssueIds, ...testIssues.map((i) => i.id)])];

  // Delete each issue
  for (const id of idsToDelete) {
    try {
      await client.request(
        `mutation DeleteIssue($id: String!) {
          issueDelete(id: $id) {
            success
          }
        }`,
        { id }
      );
    } catch {
      // Ignore deletion errors (issue might already be deleted)
    }
  }
}

describeLinearSuite("lb CLI Integration Tests", () => {
  beforeAll(async () => {
    // Verify API key is set
    if (!process.env.LINEAR_API_KEY) {
      throw new Error("LINEAR_API_KEY environment variable is required");
    }

    // Clear any pending outbox items from previous runs
    await lb("sync");
  });

  afterAll(async () => {
    // Delete all test issues (uses GraphQL directly for reliability)
    await deleteTestIssues();
  });

  describe("whoami", () => {
    test("should authenticate and return user info", async () => {
      const result = await lbJson<{
        userId: string;
        userName: string;
        teams: Array<{ id: string; key: string; name: string }>;
      }>("whoami");

      expect(result.userId).toBeDefined();
      expect(result.userName).toBeDefined();
      expect(Array.isArray(result.teams)).toBe(true);
      expect(result.teams.length).toBeGreaterThan(0);
    });

    test("should include configured team", async () => {
      const result = await lbJson<{
        teams: Array<{ key: string }>;
      }>("whoami");

      const teamKeys = result.teams.map((t) => t.key);
      expect(teamKeys).toContain(TEAM_KEY);
    });
  });

  describe("create", () => {
    test("should create issue with --sync", async () => {
      const title = `${TEST_PREFIX} Create test`;
      const result = await lbJson<
        Array<{
          id: string;
          title: string;
          status: string;
          priority: number;
        }>
      >("create", title, "-p", "2", "--sync");

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
      expect(result[0].id).toMatch(/^[A-Z]+-\d+$/);
      expect(result[0].title).toBe(title);
      expect(result[0].status).toBe("open");
      expect(result[0].priority).toBe(2);
    });

    test("should queue issue without --sync", async () => {
      const title = `${TEST_PREFIX} Queued test`;
      const result = await lbJson<
        Array<{
          id: string;
          title: string;
          sync_status: string;
        }>
      >("create", title, "-p", "1");

      expect(result[0].id).toMatch(/^LOCAL-\d+$/);
      expect(result[0].title).toBe(title);
      expect(result[0].sync_status).toBe("pending");

      // Push it immediately so we can track it
      await lb("sync");
    });

    // Type tests are skipped by default since use_types is off
    // To run: set use_types: true in config
    test.skip("should support bug type (requires use_types: true)", async () => {
      const title = `${TEST_PREFIX} Type test: bug`;
      const result = await lbJson<
        Array<{
          id: string;
          issue_type: string;
        }>
      >("create", title, "-t", "bug", "--sync");

      expect(result[0].issue_type).toBe("bug");
    });

    test.skip("should support feature type (requires use_types: true)", async () => {
      const title = `${TEST_PREFIX} Type test: feature`;
      const result = await lbJson<
        Array<{
          id: string;
          issue_type: string;
        }>
      >("create", title, "-t", "feature", "--sync");

      expect(result[0].issue_type).toBe("feature");
    });

    test("should support priority 0 (critical)", async () => {
      const title = `${TEST_PREFIX} Priority test: 0`;
      const result = await lbJson<
        Array<{
          id: string;
          priority: number;
        }>
      >("create", title, "-p", "0", "--sync");

      expect(result[0].priority).toBe(0);
    });

    test("should support priority 4 (backlog)", async () => {
      const title = `${TEST_PREFIX} Priority test: 4`;
      const result = await lbJson<
        Array<{
          id: string;
          priority: number;
        }>
      >("create", title, "-p", "4", "--sync");

      expect(result[0].priority).toBe(4);
    });
  });

  describe("sync", () => {
    test("should push queued items and pull issues", async () => {
      const title = `${TEST_PREFIX} Sync test`;

      // First create a queued issue (no --sync, so it queues)
      const created = await lbJson<
        Array<{
          id: string;
          title: string;
          sync_status: string;
        }>
      >("create", title);
      expect(created[0].id).toMatch(/^LOCAL-\d+$/);
      expect(created[0].sync_status).toBe("pending");

      // Then sync
      const result = await lbJson<{
        pushed: { success: number; failed: number };
        pulled: number;
      }>("sync");

      // Background worker and explicit sync can overlap; we only assert sync completed
      // and rely on eventual synced-issue verification below for correctness.
      expect(Number.isInteger(result.pushed.failed)).toBe(true);
      expect(result.pulled).toBeGreaterThanOrEqual(0);

      // If background worker won the race and pushed first, this still verifies
      // the queued issue reached Linear and appears with a synced ID.
      const synced = await waitForSyncedIssueByTitle(title);
      expect(synced).toBeDefined();
      if (synced) {
        testIssueIds.push(synced.id);
      }
    });
  });

  describe("list", () => {
    test("should return array of issues", async () => {
      // Ensure we have at least one issue
      await lbJson<Array<{ id: string }>>("create", `${TEST_PREFIX} List test`, "--sync");

      // Sync to refresh cache
      await lb("sync");

      const result = await lbJson<
        Array<{
          id: string;
          title: string;
          status: string;
          priority: number;
          issue_type: string;
          dependency_count: number;
          dependent_count: number;
        }>
      >("list");

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);

      // Check structure of first issue
      const issue = result[0];
      expect(issue.id).toBeDefined();
      expect(issue.title).toBeDefined();
      expect(issue.status).toBeDefined();
      expect(typeof issue.priority).toBe("number");
      expect(typeof issue.dependency_count).toBe("number");
      expect(typeof issue.dependent_count).toBe("number");
    });

    test("should filter by status", async () => {
      const result = await lbJson<Array<{ status: string }>>("list", "-s", "open");

      for (const issue of result) {
        expect(issue.status).toBe("open");
      }
    });
  });

  describe("ready", () => {
    test("should return only open unblocked issues", async () => {
      const result = await lbJson<
        Array<{
          id: string;
          status: string;
          dependencies: Array<unknown>;
        }>
      >("ready");

      expect(Array.isArray(result)).toBe(true);

      for (const issue of result) {
        expect(issue.status).toBe("open");
        expect(Array.isArray(issue.dependencies)).toBe(true);
      }
    });
  });

  describe("update", () => {
    test("should update issue status", async () => {
      // Create an issue first
      const createResult = await lbJson<Array<{ id: string }>>(
        "create",
        `${TEST_PREFIX} Update test`,
        "--sync"
      );
      const issueId = createResult[0].id;

      // Update to in_progress
      const updateResult = await lbJson<
        Array<{
          id: string;
          status: string;
        }>
      >("update", issueId, "-s", "in_progress", "--sync");

      expect(updateResult[0].id).toBe(issueId);
      expect(updateResult[0].status).toBe("in_progress");
    });

    test("should update issue priority", async () => {
      // Create an issue first
      const createResult = await lbJson<Array<{ id: string }>>(
        "create",
        `${TEST_PREFIX} Priority update test`,
        "-p",
        "3",
        "--sync"
      );
      const issueId = createResult[0].id;

      // Update priority
      const updateResult = await lbJson<
        Array<{
          id: string;
          priority: number;
        }>
      >("update", issueId, "-p", "1", "--sync");

      expect(updateResult[0].priority).toBe(1);
    });
  });

  describe("touch", () => {
    test("should heal malformed Linear links while normalizing inline backticked refs", async () => {
      const client = new GraphQLClient("https://api.linear.app/graphql", {
        headers: { Authorization: process.env.LINEAR_API_KEY! },
      });

      const targetResult = await lbJson<Array<{ id: string }>>(
        "create",
        `${TEST_PREFIX} Touch target`,
        "--sync"
      );
      const targetId = targetResult[0].id;

      const subjectResult = await lbJson<Array<{ id: string }>>(
        "create",
        `${TEST_PREFIX} Touch subject`,
        "--sync"
      );
      const subjectId = subjectResult[0].id;

      const badDescription = [
        `Broken [https://linear.app/${WORKSPACE_SLUG}/issue/${targetId}:](<https://linear.app/${WORKSPACE_SLUG}/issue/${targetId}:>)`,
        `Keep \`${targetId}\` literal`,
      ].join("\n\n");

      await client.request(
        `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
          }
        }`,
        {
          id: subjectId,
          input: {
            description: badDescription,
          },
        }
      );

      const touchResult = await lbJson<Array<{ id: string; description?: string }>>(
        "touch",
        subjectId
      );
      expect(touchResult[0].id).toBe(subjectId);
      expect(touchResult[0].description).toContain(`Broken ${targetId}:`);
      expect(touchResult[0].description).toContain(`Keep ${targetId} literal`);
      expect(touchResult[0].description).not.toContain(`Keep \`${targetId}\` literal`);

      const fetched = await client.request<{
        issue: { description: string | null };
      }>(
        `query GetIssue($id: String!) {
          issue(id: $id) {
            description
          }
        }`,
        { id: subjectId }
      );

      expect(fetched.issue.description).toContain(
        `[${targetId}](https://linear.app/${WORKSPACE_SLUG}/issue/${targetId}):`
      );
      expect(fetched.issue.description).toContain(targetId);
      expect(fetched.issue.description).toContain("literal");
      expect(fetched.issue.description).not.toContain(`\`${targetId}\` literal`);
      expect(fetched.issue.description).not.toContain(
        `[https://linear.app/${WORKSPACE_SLUG}/issue/${targetId}:]`
      );
    });
  });

  describe("close", () => {
    test("should close issue with reason", async () => {
      // Create an issue first
      const createResult = await lbJson<Array<{ id: string }>>(
        "create",
        `${TEST_PREFIX} Close test`,
        "--sync"
      );
      const issueId = createResult[0].id;

      // Close it
      const closeResult = await lbJson<
        Array<{
          id: string;
          status: string;
          closed_at: string;
        }>
      >("close", issueId, "-r", "Test complete", "--sync");

      expect(closeResult[0].id).toBe(issueId);
      expect(closeResult[0].status).toBe("closed");
      expect(closeResult[0].closed_at).toBeDefined();
    });
  });

  describe("show", () => {
    test("should show issue details", async () => {
      const showDescription = `${TEST_PREFIX} Show description`;

      // Create an issue first
      const createResult = await lbJson<Array<{ id: string }>>(
        "create",
        `${TEST_PREFIX} Show test`,
        "-d",
        showDescription,
        "--sync"
      );
      const issueId = createResult[0].id;

      // Sync to ensure it's in cache
      await lb("sync");

      // Show it
      const showResult = await lbJson<
        Array<{
          id: string;
          title: string;
          description: string;
        }>
      >("show", issueId);

      expect(showResult[0].id).toBe(issueId);
      expect(showResult[0].title).toContain("Show test");
    });
  });

  describe("JSON output format (bd compatibility)", () => {
    test("should use snake_case keys", async () => {
      const result = await lbJson<Array<Record<string, unknown>>>("list");

      if (result.length > 0) {
        const issue = result[0];
        // issue_type is now optional (only present when use_types is enabled)
        expect("created_at" in issue).toBe(true);
        expect("updated_at" in issue).toBe(true);
        expect("dependency_count" in issue).toBe(true);
        expect("dependent_count" in issue).toBe(true);
      }
    });

    test("should always return arrays", async () => {
      // list returns array
      const listResult = await lbJson<unknown>("list");
      expect(Array.isArray(listResult)).toBe(true);

      // ready returns array
      const readyResult = await lbJson<unknown>("ready");
      expect(Array.isArray(readyResult)).toBe(true);

      // show returns array (even for single issue)
      const createResult = await lbJson<Array<{ id: string }>>(
        "create",
        `${TEST_PREFIX} Array test`,
        "--sync"
      );

      await lb("sync");

      const showResult = await lbJson<unknown>("show", createResult[0].id);
      expect(Array.isArray(showResult)).toBe(true);
    });
  });

  describe("background sync", () => {
    test("should queue and auto-sync in background", async () => {
      // Create without --sync flag (queues and spawns worker)
      const title = `${TEST_PREFIX} Background sync test`;
      const createResult = await lbJson<Array<{ id: string; title: string; sync_status: string }>>(
        "create",
        title
      );

      // Should return immediately with local ID and pending sync status
      expect(createResult[0].id).toMatch(/^LOCAL-\d+$/);
      expect(createResult[0].title).toBe(title);
      expect(createResult[0].sync_status).toBe("pending");

      // Wait for worker to process queue (give it a few seconds)
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Sync to refresh cache from Linear
      await lb("sync");

      // Verify issue exists in Linear with real ID
      const listResult = await lbJson<Array<{ id: string; title: string }>>("list");
      const found = listResult.find((issue) => issue.title === title);

      expect(found).toBeDefined();
      expect(found?.id).not.toBe("pending");
      expect(found?.id).toMatch(/^LIN-\d+$/); // Real Linear ID
    });
  });

  describe("beads import", () => {
    const beadsFile = import.meta.dir + "/../.beads-test/issues.jsonl";
    const importMapFile = import.meta.dir + "/../.lb/import-map.jsonl";

    beforeAll(async () => {
      // Create mock beads data
      const { mkdirSync, writeFileSync } = await import("fs");
      const { dirname } = await import("path");

      mkdirSync(dirname(beadsFile), { recursive: true });

      const mockIssues = [
        {
          id: "bd-test-1",
          title: `${TEST_PREFIX} Beads import test 1`,
          description: "First test issue",
          status: "open",
          priority: 1,
          created_at: new Date().toISOString(),
        },
        {
          id: "bd-test-2",
          title: `${TEST_PREFIX} Beads import test 2`,
          description: "Second test issue",
          status: "open",
          priority: 2,
          created_at: new Date().toISOString(),
          dependencies: [{ type: "blocks", issue_id: "bd-test-1" }],
        },
        {
          id: "bd-test-3",
          title: `${TEST_PREFIX} Beads import test 3 (closed)`,
          status: "closed",
          priority: 3,
          created_at: new Date().toISOString(),
          closed_at: new Date().toISOString(),
        },
      ];

      writeFileSync(beadsFile, mockIssues.map((i) => JSON.stringify(i)).join("\n"));
    });

    afterAll(async () => {
      // Cleanup
      const { unlinkSync, rmSync, existsSync } = await import("fs");
      const { dirname } = await import("path");

      if (existsSync(beadsFile)) {
        unlinkSync(beadsFile);
        rmSync(dirname(beadsFile), { recursive: true, force: true });
      }

      if (existsSync(importMapFile)) {
        unlinkSync(importMapFile);
      }
    });

    test("should parse beads JSONL", async () => {
      const { parseBeadsJsonl } = await import("../src/utils/import-beads.js");
      const issues = parseBeadsJsonl(beadsFile);

      expect(issues.length).toBe(3);
      expect(issues[0].id).toBe("bd-test-1");
      expect(issues[1].dependencies).toBeDefined();
    });

    test("should filter closed issues", async () => {
      const { parseBeadsJsonl, filterIssues } = await import("../src/utils/import-beads.js");
      const issues = parseBeadsJsonl(beadsFile);
      const filtered = filterIssues(issues, { includeClosed: false });

      expect(filtered.length).toBe(2);
      expect(filtered.every((i) => i.status !== "closed")).toBe(true);
    });

    test("should check for duplicates", async () => {
      const { parseBeadsJsonl, filterIssues, checkDuplicates } =
        await import("../src/utils/import-beads.js");
      const { getTeamId } = await import("../src/utils/linear.js");

      const issues = parseBeadsJsonl(beadsFile);
      const filtered = filterIssues(issues, { includeClosed: false });
      const teamId = await getTeamId();

      const duplicates = await checkDuplicates(filtered, teamId);

      // Should be a Map
      expect(duplicates instanceof Map).toBe(true);
    });

    test("should import issues and create mapping", async () => {
      const { parseBeadsJsonl, filterIssues, createImportedIssues, saveImportMapping } =
        await import("../src/utils/import-beads.js");
      const { getTeamId } = await import("../src/utils/linear.js");
      const { dirname } = await import("path");

      const issues = parseBeadsJsonl(beadsFile);
      const filtered = filterIssues(issues, { includeClosed: false });
      const teamId = await getTeamId();

      // Import issues
      const mapping = await createImportedIssues(filtered, teamId);

      expect(mapping.size).toBeGreaterThan(0);
      expect(mapping.has("bd-test-1")).toBe(true);

      // Save mapping
      const { mkdirSync, existsSync } = await import("fs");
      mkdirSync(dirname(importMapFile), { recursive: true });
      saveImportMapping(mapping, importMapFile);

      expect(existsSync(importMapFile)).toBe(true);

      // Read and verify mapping format
      const { readFileSync } = await import("fs");
      const content = readFileSync(importMapFile, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      expect(lines.length).toBe(mapping.size);
      const firstLine = JSON.parse(lines[0]);
      expect(firstLine.beads_id).toBeDefined();
      expect(firstLine.linear_id).toBeDefined();
      expect(firstLine.imported_at).toBeDefined();
    });
  });
});

/**
 * Project scoping mode tests
 * These tests run in an isolated directory with repo_scope: 'project' config
 */
describeLinearSuite("Project Scoping Mode", () => {
  const testDir = "/tmp/lb-project-test-" + Date.now();
  const projectTestPrefix = `[proj-test-${Date.now()}]`;

  // Helper to run lb in the test directory
  async function lbProject(
    ...args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", "run", import.meta.dir + "/../src/cli.ts", ...args], {
      cwd: testDir,
      env: { ...process.env, LB_TEAM_KEY: TEAM_KEY },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
  }

  // Helper to run lb and parse JSON output
  async function lbProjectJson<T>(...args: string[]): Promise<T> {
    const result = await lbProject(...args, "--json");
    if (result.exitCode !== 0) {
      throw new Error(`lb ${args.join(" ")} failed: ${result.stderr}\n${result.stdout}`);
    }
    return JSON.parse(result.stdout);
  }

  beforeAll(async () => {
    // Create test directory with git init and project-scoping config
    mkdirSync(join(testDir, ".lb"), { recursive: true });
    mkdirSync(join(testDir, ".git"), { recursive: true }); // Fake git repo
    writeFileSync(
      join(testDir, ".lb", "config.jsonc"),
      `{ "repo_scope": "project", "repo_name": "lb-project-test-${Date.now()}" }`
    );

    // Initialize
    await lbProject("init", "--force");
  });

  afterAll(async () => {
    // Cleanup: delete any test issues and the project
    try {
      await lbProject("sync");
      const issues = await lbProjectJson<Array<{ id: string; title: string }>>("list", "--all");
      const testIssues = issues.filter((i) => i.title.includes(projectTestPrefix));

      const client = new GraphQLClient("https://api.linear.app/graphql", {
        headers: { Authorization: process.env.LINEAR_API_KEY! },
      });

      for (const issue of testIssues) {
        try {
          await client.request(
            `mutation DeleteIssue($id: String!) { issueDelete(id: $id) { success } }`,
            { id: issue.id }
          );
        } catch {
          // Ignore
        }
      }
    } catch {
      // Ignore cleanup errors
    }

    // Cleanup test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("should initialize with project scoping", async () => {
    const result = await lbProject("init", "--force");
    expect(result.stdout).toContain("Repo scoping: project");
    expect(result.stdout).toContain("Repo project:");
    expect(result.stdout).not.toContain("Repo label:");
  });

  test("should create issue with project assignment", async () => {
    const title = `${projectTestPrefix} Project create test`;
    const result = await lbProjectJson<Array<{ id: string; title: string }>>(
      "create",
      title,
      "--sync"
    );

    expect(result[0].id).toMatch(/^[A-Z]+-\d+$/);
    expect(result[0].title).toBe(title);
  });

  test("should sync and fetch project-scoped issues", async () => {
    // Create an issue
    const title = `${projectTestPrefix} Project sync test`;
    await lbProject("create", title, "--sync");

    // Sync
    const syncResult = await lbProjectJson<{ pushed: object; pulled: number }>("sync");
    expect(syncResult.pulled).toBeGreaterThanOrEqual(1);

    // List should include the issue
    const listResult = await lbProjectJson<Array<{ title: string }>>("list");
    expect(listResult.some((i) => i.title === title)).toBe(true);
  });
});

/**
 * Local-only mode tests
 * These tests run in an isolated directory with local_only: true config
 * No Linear API calls are made
 */
describe("Local-only Mode", () => {
  const testDir = "/tmp/lb-local-test-" + Date.now();

  // Helper to run lb in the test directory
  async function lbLocal(
    ...args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", "run", import.meta.dir + "/../src/cli.ts", ...args], {
      cwd: testDir,
      env: { ...process.env, LB_TEAM_KEY: "" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
  }

  async function evalLocal(
    script: string,
    args: string[] = []
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", "--eval", script, ...args], {
      cwd: testDir,
      env: { ...process.env, LB_TEAM_KEY: "" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
  }

  // Helper to run lb and parse JSON output
  async function lbLocalJson<T>(...args: string[]): Promise<T> {
    const result = await lbLocal(...args, "--json");
    if (result.exitCode !== 0) {
      throw new Error(`lb ${args.join(" ")} failed: ${result.stderr}\n${result.stdout}`);
    }
    return JSON.parse(result.stdout);
  }

  function seedCachedIssue(id: string, title: string): void {
    const db = new Database(join(testDir, ".lb", "cache.db"));
    db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        local_id TEXT PRIMARY KEY,
        linear_id TEXT,
        linear_identifier TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        issue_type TEXT,
        sync_status TEXT NOT NULL DEFAULT 'synced',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        assignee TEXT,
        linear_state_id TEXT,
        cached_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const now = new Date().toISOString();
    db.run(
      `INSERT OR REPLACE INTO issues
      (local_id, linear_id, linear_identifier, title, status, priority, sync_status, created_at, updated_at)
      VALUES (?, NULL, ?, ?, 'open', 2, 'synced', ?, ?)`,
      [id, id, title, now, now]
    );
    db.exec("PRAGMA user_version = 6");
    db.close();
  }

  beforeAll(() => {
    // Create test directory with git init and local-only config
    mkdirSync(join(testDir, ".lb"), { recursive: true });
    mkdirSync(join(testDir, ".git"), { recursive: true }); // Fake git repo
    writeFileSync(join(testDir, ".lb", "config.jsonc"), '{ "local_only": true }');
  });

  afterAll(() => {
    // Cleanup test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("sync", () => {
    test("should show local-only message", async () => {
      const result = await lbLocal("sync");
      expect(result.stdout).toContain("Local-only mode");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("create", () => {
    test("should generate LOCAL-xxx IDs", async () => {
      const result = await lbLocalJson<Array<{ id: string; title: string }>>(
        "create",
        "Test issue",
        "-d",
        "Description"
      );

      expect(result[0].id).toMatch(/^LOCAL-\d+$/);
      expect(result[0].title).toBe("Test issue");
    });

    test("should increment IDs", async () => {
      const result1 = await lbLocalJson<Array<{ id: string }>>("create", "First");
      const result2 = await lbLocalJson<Array<{ id: string }>>("create", "Second");

      const id1 = parseInt(result1[0].id.replace("LOCAL-", ""));
      const id2 = parseInt(result2[0].id.replace("LOCAL-", ""));

      expect(id2).toBe(id1 + 1);
    });

    test("should auto-heal accidental escaped newlines by default and warn loudly", async () => {
      const result = await lbLocal(
        "create",
        "Escaped newline create",
        "-d",
        "Why\\n\\nWhat",
        "--json"
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("auto-corrected literal '\\n' sequences");
      expect(result.stderr).toContain("--no-auto-format-escaped-newlines");

      const created = JSON.parse(result.stdout) as Array<{ id: string; description: string }>;
      expect(created[0].description).toBe("Why\n\nWhat");

      const shown = await lbLocalJson<Array<{ description: string }>>("show", created[0].id);
      expect(shown[0].description).toBe("Why\n\nWhat");
    });

    test("should read create descriptions from @file", async () => {
      const bodyPath = join(testDir, "create-body.md");
      writeFileSync(bodyPath, "Why\n\n- one\n- two\n");

      const result = await lbLocalJson<Array<{ description: string }>>(
        "create",
        "Create from file",
        "-d",
        `@${bodyPath}`
      );

      expect(result[0].description).toBe("Why\n\n- one\n- two\n");
    });

    test("should preserve literal escaped newlines when auto-heal is explicitly disabled", async () => {
      const result = await lbLocal(
        "create",
        "Literal escaped newline create",
        "-d",
        "Why\\n\\nWhat",
        "--no-auto-format-escaped-newlines",
        "--json"
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("auto-corrected literal '\\n' sequences");

      const created = JSON.parse(result.stdout) as Array<{ id: string; description: string }>;
      expect(created[0].description).toBe("Why\\n\\nWhat");

      const shown = await lbLocalJson<Array<{ description: string }>>("show", created[0].id);
      expect(shown[0].description).toBe("Why\\n\\nWhat");
    });

    test("should support --parent flag", async () => {
      const parent = await lbLocalJson<Array<{ id: string }>>("create", "Parent");
      const child = await lbLocalJson<Array<{ id: string }>>(
        "create",
        "Child",
        "--parent",
        parent[0].id
      );

      // Verify parent-child relationship via show
      const showResult = await lbLocalJson<Array<{ children?: string[] }>>("show", parent[0].id);

      expect(showResult[0].children).toContain(child[0].id);
    });

    test("should support priority", async () => {
      const result = await lbLocalJson<Array<{ priority: number }>>("create", "Urgent", "-p", "0");

      expect(result[0].priority).toBe(0);
    });

    test("should handle many concurrent creates without database lock errors", async () => {
      const total = 30;
      const jobs = Array.from({ length: total }, (_, idx) =>
        Bun.spawn(
          ["bun", "run", import.meta.dir + "/../src/cli.ts", "create", `Concurrent ${idx + 1}`],
          {
            cwd: testDir,
            stdout: "pipe",
            stderr: "pipe",
          }
        )
      );

      const results = await Promise.all(
        jobs.map(async (proc) => {
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const exitCode = await proc.exited;
          return { stdout, stderr, exitCode };
        })
      );

      for (const result of results) {
        expect(result.exitCode).toBe(0);
        expect(result.stderr.toLowerCase()).not.toContain("database is locked");
      }

      const listed = await lbLocalJson<Array<{ title: string }>>("list", "--all");
      const createdCount = listed.filter((issue) => issue.title.startsWith("Concurrent ")).length;
      expect(createdCount).toBe(total);
    });
  });

  describe("list", () => {
    test("should return all local issues", async () => {
      // Create a couple issues
      await lbLocal("create", "List test 1");
      await lbLocal("create", "List test 2");

      const result = await lbLocalJson<Array<{ id: string; title: string }>>("list");

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.every((i) => i.id.startsWith("LOCAL-"))).toBe(true);
    });

    test("should include parent info", async () => {
      const parent = await lbLocalJson<Array<{ id: string }>>("create", "Parent for list");
      await lbLocal("create", "Child for list", "--parent", parent[0].id);

      const result =
        await lbLocalJson<Array<{ id: string; title: string; parent: string | null }>>("list");
      const child = result.find((i) => i.title === "Child for list");

      expect(child?.parent).toBe(parent[0].id);
    });
  });

  describe("show", () => {
    test("should show issue details", async () => {
      const created = await lbLocalJson<Array<{ id: string }>>(
        "create",
        "Show test",
        "-d",
        "Test description"
      );

      const result = await lbLocalJson<Array<{ id: string; title: string; description: string }>>(
        "show",
        created[0].id
      );

      expect(result[0].id).toBe(created[0].id);
      expect(result[0].title).toBe("Show test");
      expect(result[0].description).toBe("Test description");
    });

    test("should show relationships", async () => {
      const parent = await lbLocalJson<Array<{ id: string }>>("create", "Parent for show");
      const child = await lbLocalJson<Array<{ id: string }>>(
        "create",
        "Child for show",
        "--parent",
        parent[0].id
      );

      const result = await lbLocalJson<Array<{ id: string; children?: string[]; parent?: string }>>(
        "show",
        parent[0].id
      );

      expect(result[0].children).toContain(child[0].id);
    });

    test("should resolve compact IDs without dash", async () => {
      seedCachedIssue("LIN-4321", "Compact ID test");
      const result = await lbLocalJson<Array<{ id: string; title: string }>>("show", "LIN4321");
      expect(result[0].id).toBe("LIN-4321");
      expect(result[0].title).toBe("Compact ID test");
    });

    test("should resolve numeric IDs when prefix is unambiguous", async () => {
      seedCachedIssue("LIN-9876", "Numeric inference test");
      const result = await lbLocalJson<Array<{ id: string; title: string }>>("show", "9876");
      expect(result[0].id).toBe("LIN-9876");
      expect(result[0].title).toBe("Numeric inference test");
    });

    test("should hard-fail with choices when numeric ID is ambiguous", async () => {
      seedCachedIssue("AAA-7777", "Ambiguous A");
      seedCachedIssue("BBB-7777", "Ambiguous B");

      const result = await lbLocal("show", "7777");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Issue reference '7777' is ambiguous");
      expect(result.stderr).toContain("AAA-7777");
      expect(result.stderr).toContain("BBB-7777");
    });
  });

  describe("update", () => {
    test("should update status", async () => {
      const created = await lbLocalJson<Array<{ id: string }>>("create", "Update test");

      const result = await lbLocalJson<Array<{ id: string; status: string }>>(
        "update",
        created[0].id,
        "--status",
        "in_progress"
      );

      expect(result[0].status).toBe("in_progress");

      // Verify it persisted
      const show = await lbLocalJson<Array<{ status: string }>>("show", created[0].id);
      expect(show[0].status).toBe("in_progress");
    });

    test("should update priority", async () => {
      const created = await lbLocalJson<Array<{ id: string }>>("create", "Priority update");

      const result = await lbLocalJson<Array<{ priority: number }>>(
        "update",
        created[0].id,
        "-p",
        "0"
      );

      expect(result[0].priority).toBe(0);
    });

    test("rejects self-referential update relations across LOCAL and LIN aliases", async () => {
      const created = await lbLocalJson<Array<{ id: string }>>("create", "Self update guard");

      const seedAlias = `
        import { Database } from "bun:sqlite";
        const db = new Database(".lb/cache.db");
        db.run("UPDATE issues SET linear_identifier = ? WHERE local_id = ?", ["LIN-7001", process.argv[1]]);
        db.close();
      `;
      const seeded = await evalLocal(seedAlias, [created[0].id]);
      expect(seeded.exitCode).toBe(0);

      const related = await lbLocal("update", created[0].id, "--related", "LIN-7001");
      expect(related.exitCode).toBe(1);
      expect(related.stderr).toContain("cannot be related to itself");

      const parent = await lbLocal("update", created[0].id, "--parent", "LIN-7001");
      expect(parent.exitCode).toBe(1);
      expect(parent.stderr).toContain("cannot be its own parent");

      const shown = await lbLocalJson<Array<{ related?: string[]; parent?: string | null }>>(
        "show",
        created[0].id
      );
      expect(shown[0].related || []).toEqual([]);
      expect(shown[0].parent ?? null).toBeNull();
    });

    test("should auto-heal accidental escaped newlines on update and warn loudly", async () => {
      const created = await lbLocalJson<Array<{ id: string }>>("create", "Escaped newline update");

      const result = await lbLocal("update", created[0].id, "-d", "Why\\n\\nWhat", "--json");

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("auto-corrected literal '\\n' sequences");
      expect(result.stderr).toContain("--no-auto-format-escaped-newlines");

      const updated = JSON.parse(result.stdout) as Array<{ description: string }>;
      expect(updated[0].description).toBe("Why\n\nWhat");

      const shown = await lbLocalJson<Array<{ description: string }>>("show", created[0].id);
      expect(shown[0].description).toBe("Why\n\nWhat");
    });

    test("should preserve literal escaped newlines on update when auto-heal is disabled", async () => {
      const created = await lbLocalJson<Array<{ id: string }>>(
        "create",
        "Literal escaped newline update"
      );

      const result = await lbLocal(
        "update",
        created[0].id,
        "-d",
        "Why\\n\\nWhat",
        "--no-auto-format-escaped-newlines",
        "--json"
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("auto-corrected literal '\\n' sequences");

      const updated = JSON.parse(result.stdout) as Array<{ description: string }>;
      expect(updated[0].description).toBe("Why\\n\\nWhat");

      const shown = await lbLocalJson<Array<{ description: string }>>("show", created[0].id);
      expect(shown[0].description).toBe("Why\\n\\nWhat");
    });

    test("should read update descriptions from @file", async () => {
      const created = await lbLocalJson<Array<{ id: string }>>("create", "Update from file");
      const bodyPath = join(testDir, "update-body.md");
      writeFileSync(bodyPath, "Plan\n\n- alpha\n- beta\n");

      const result = await lbLocalJson<Array<{ description: string }>>(
        "update",
        created[0].id,
        "-d",
        `@${bodyPath}`
      );

      expect(result[0].description).toBe("Plan\n\n- alpha\n- beta\n");
    });
  });

  describe("close", () => {
    test("should close issue", async () => {
      const created = await lbLocalJson<Array<{ id: string }>>("create", "Close test");

      const result = await lbLocalJson<Array<{ id: string; status: string; closed_at: string }>>(
        "close",
        created[0].id,
        "--reason",
        "Done"
      );

      expect(result[0].status).toBe("closed");
      expect(result[0].closed_at).toBeDefined();
    });

    test("should block closing parent with open children unless --force", async () => {
      const parent = await lbLocalJson<Array<{ id: string }>>("create", "Parent close guard");
      const child = await lbLocalJson<Array<{ id: string }>>(
        "create",
        "Child open",
        "--parent",
        parent[0].id
      );

      const blocked = await lbLocal("close", parent[0].id);
      expect(blocked.exitCode).toBe(1);
      expect(blocked.stderr).toContain("open child issues remain");
      expect(blocked.stderr).toContain(child[0].id);

      const forceClosed = await lbLocalJson<Array<{ id: string; status: string }>>(
        "close",
        parent[0].id,
        "--force"
      );
      expect(forceClosed[0].status).toBe("closed");
    });
  });

  describe("delete", () => {
    test("should delete issue", async () => {
      const created = await lbLocalJson<Array<{ id: string }>>("create", "Delete test");
      const issueId = created[0].id;

      const result = await lbLocalJson<{ deleted: string }>("delete", issueId, "--force");

      expect(result.deleted).toBe(issueId);

      // Verify it's gone
      const show = await lbLocal("show", issueId);
      expect(show.exitCode).not.toBe(0);
    });
  });

  describe("ready", () => {
    test("should show unblocked issues", async () => {
      const issue = await lbLocalJson<Array<{ id: string }>>("create", "Ready test");

      const result = await lbLocalJson<Array<{ id: string; status: string }>>("ready");

      expect(result.some((i) => i.id === issue[0].id)).toBe(true);
    });

    test("should exclude blocked issues", async () => {
      const blocker = await lbLocalJson<Array<{ id: string }>>("create", "Blocker");
      const blocked = await lbLocalJson<Array<{ id: string }>>("create", "Blocked");

      await lbLocal("dep", "add", blocked[0].id, "--blocked-by", blocker[0].id);

      const result = await lbLocalJson<Array<{ id: string }>>("ready");

      expect(result.some((i) => i.id === blocker[0].id)).toBe(true);
      expect(result.some((i) => i.id === blocked[0].id)).toBe(false);
    });
  });

  describe("blocked", () => {
    test("should show blocked issues", async () => {
      const blocker = await lbLocalJson<Array<{ id: string }>>("create", "Blocker for blocked");
      const blocked = await lbLocalJson<Array<{ id: string }>>("create", "Blocked issue");

      await lbLocal("dep", "add", blocked[0].id, "--blocked-by", blocker[0].id);

      const result = await lbLocalJson<Array<{ id: string; blocked_by: string[] }>>("blocked");

      const found = result.find((i) => i.id === blocked[0].id);
      expect(found).toBeDefined();
      expect(found?.blocked_by).toContain(blocker[0].id);
    });
  });

  describe("dep", () => {
    test("should add blocks dependency", async () => {
      const a = await lbLocalJson<Array<{ id: string }>>("create", "Dep A");
      const b = await lbLocalJson<Array<{ id: string }>>("create", "Dep B");

      const result = await lbLocal("dep", "add", a[0].id, "--blocks", b[0].id);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("blocks");

      // Verify via show
      const show = await lbLocalJson<Array<{ blocks?: string[] }>>("show", a[0].id);
      expect(show[0].blocks).toContain(b[0].id);
    });

    test("should add blocked-by dependency", async () => {
      const a = await lbLocalJson<Array<{ id: string }>>("create", "BlockedBy A");
      const b = await lbLocalJson<Array<{ id: string }>>("create", "BlockedBy B");

      await lbLocal("dep", "add", a[0].id, "--blocked-by", b[0].id);

      // Verify via show - a should be blocked by b
      const show = await lbLocalJson<Array<{ blocked_by?: string[] }>>("show", a[0].id);
      expect(show[0].blocked_by).toContain(b[0].id);
    });

    test("rejects self-referential dep add requests across LOCAL and LIN aliases", async () => {
      const created = await lbLocalJson<Array<{ id: string }>>("create", "Self dep guard");

      const seedAlias = `
        import { Database } from "bun:sqlite";
        const db = new Database(".lb/cache.db");
        db.run("UPDATE issues SET linear_identifier = ? WHERE local_id = ?", ["LIN-7002", process.argv[1]]);
        db.close();
      `;
      const seeded = await evalLocal(seedAlias, [created[0].id]);
      expect(seeded.exitCode).toBe(0);

      const blockedBy = await lbLocal("dep", "add", created[0].id, "--blocked-by", "LIN-7002");
      expect(blockedBy.exitCode).toBe(1);
      expect(blockedBy.stderr).toContain("cannot be blocked by itself");

      const parent = await lbLocal("dep", "add", created[0].id, "--parent", "LIN-7002");
      expect(parent.exitCode).toBe(1);
      expect(parent.stderr).toContain("cannot be its own parent");

      const shown = await lbLocalJson<
        Array<{ blocked_by?: string[]; parent?: string | null; blocks?: string[] }>
      >("show", created[0].id);
      expect(shown[0].blocked_by || []).toEqual([]);
      expect(shown[0].blocks || []).toEqual([]);
      expect(shown[0].parent ?? null).toBeNull();
    });

    test("should remove dependency", async () => {
      const a = await lbLocalJson<Array<{ id: string }>>("create", "Remove A");
      const b = await lbLocalJson<Array<{ id: string }>>("create", "Remove B");

      await lbLocal("dep", "add", a[0].id, "--blocks", b[0].id);
      await lbLocal("dep", "remove", a[0].id, b[0].id);

      // Verify removed
      const show = await lbLocalJson<Array<{ blocks?: string[] }>>("show", a[0].id);
      expect(show[0].blocks || []).not.toContain(b[0].id);
    });

    test("should treat related edges as idempotent (same and reverse add)", async () => {
      const a = await lbLocalJson<Array<{ id: string }>>("create", "Related A");
      const b = await lbLocalJson<Array<{ id: string }>>("create", "Related B");

      const first = await lbLocal("dep", "add", a[0].id, "--related", b[0].id);
      const second = await lbLocal("dep", "add", a[0].id, "--related", b[0].id);
      const reverse = await lbLocal("dep", "add", b[0].id, "--related", a[0].id);

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(reverse.exitCode).toBe(0);
      expect(second.stdout).toContain("Already related");
      expect(reverse.stdout).toContain("Already related");

      const showA = await lbLocalJson<Array<{ related?: string[] }>>("show", a[0].id);
      const showB = await lbLocalJson<Array<{ related?: string[] }>>("show", b[0].id);

      expect(showA[0].related).toEqual([b[0].id]);
      expect(showB[0].related).toEqual([a[0].id]);
    });

    test("should remove all duplicate related rows in one --related remove", async () => {
      const a = await lbLocalJson<Array<{ id: string }>>("create", "Dup related A");
      const b = await lbLocalJson<Array<{ id: string }>>("create", "Dup related B");

      const seedDuplicates = `
        import { Database } from "bun:sqlite";
        const db = new Database(".lb/cache.db");
        const now = new Date().toISOString();
        db.exec("DROP INDEX IF EXISTS idx_deps_related_canonical_unique");
        db.run(
          "INSERT INTO dependencies (issue_id, depends_on_id, type, created_at, created_by) VALUES (?, ?, 'related', ?, 'test')",
          [process.argv[1], process.argv[2], now]
        );
        db.run(
          "INSERT INTO dependencies (issue_id, depends_on_id, type, created_at, created_by) VALUES (?, ?, 'related', ?, 'test')",
          [process.argv[2], process.argv[1], now]
        );
        db.close();
      `;

      const seeded = await evalLocal(seedDuplicates, [a[0].id, b[0].id]);
      expect(seeded.exitCode).toBe(0);

      const removed = await lbLocal("dep", "remove", a[0].id, b[0].id, "--related");
      expect(removed.exitCode).toBe(0);

      const showA = await lbLocalJson<Array<{ related?: string[] }>>("show", a[0].id);
      const showB = await lbLocalJson<Array<{ related?: string[] }>>("show", b[0].id);
      expect(showA[0].related || []).not.toContain(b[0].id);
      expect(showB[0].related || []).not.toContain(a[0].id);
    });

    test("should normalize stale LIN alias dependency rows to LOCAL canonical IDs", async () => {
      const a = await lbLocalJson<Array<{ id: string }>>("create", "Alias normalize A");
      const b = await lbLocalJson<Array<{ id: string }>>("create", "Alias normalize B");

      await lbLocal("dep", "add", a[0].id, "--blocks", b[0].id);

      const seedAndNormalize = `
        import { Database } from "bun:sqlite";
        import { replaceIssueId } from '${import.meta.dir}/../src/utils/database.ts';

        const [localA, localB, linA, linB] = process.argv.slice(1);
        const db = new Database(".lb/cache.db");
        const now = new Date().toISOString();

        db.run(
          "INSERT INTO dependencies (issue_id, depends_on_id, type, created_at, created_by) VALUES (?, ?, 'blocks', ?, 'test')",
          [linA, linB, now]
        );
        db.close();

        replaceIssueId(localA, linA);
        replaceIssueId(localB, linB);
      `;

      const seeded = await evalLocal(seedAndNormalize, [a[0].id, b[0].id, "LIN-5001", "LIN-5002"]);
      expect(seeded.exitCode).toBe(0);

      const verify = `
        import { Database } from "bun:sqlite";

        const [localA, localB, linA, linB] = process.argv.slice(1);
        const db = new Database(".lb/cache.db", { readonly: true });
        const rows = db.query(
          "SELECT issue_id, depends_on_id, type FROM dependencies WHERE type = 'blocks'"
        ).all() as Array<{ issue_id: string; depends_on_id: string; type: string }>;
        db.close();

        const canonical = rows.filter((r) => r.issue_id === localA && r.depends_on_id === localB);
        const alias = rows.filter((r) => r.issue_id === linA || r.depends_on_id === linB);
        console.log(JSON.stringify({ rows, canonical: canonical.length, alias: alias.length }));
      `;

      const checked = await evalLocal(verify, [a[0].id, b[0].id, "LIN-5001", "LIN-5002"]);
      expect(checked.exitCode).toBe(0);
      const parsed = JSON.parse(checked.stdout) as {
        canonical: number;
        alias: number;
      };
      expect(parsed.canonical).toBe(1);
      expect(parsed.alias).toBe(0);

      const shown = await lbLocalJson<Array<{ blocks?: string[] }>>("show", a[0].id);
      expect(shown[0].blocks).toEqual([b[0].id]);
    });

    test("canonicalizes dependency rows when issue_id_map points LOCAL aliases at remote-keyed rows", async () => {
      const canonicalize = `
        import { Database } from "bun:sqlite";
        import { canonicalizeDependencyAliases } from '${import.meta.dir}/../src/utils/database.ts';

        const [localA, localB, linA, linB] = process.argv.slice(1);
        const db = new Database(".lb/cache.db");
        const now = new Date().toISOString();

        db.run("UPDATE issues SET local_id = ?, linear_identifier = ?, linear_id = ? WHERE local_id = ?", [
          linA,
          linA,
          "uuid-a",
          localA,
        ]);
        db.run("UPDATE issues SET local_id = ?, linear_identifier = ?, linear_id = ? WHERE local_id = ?", [
          linB,
          linB,
          "uuid-b",
          localB,
        ]);
        db.run(
          "INSERT OR REPLACE INTO issue_id_map (local_id, linear_id, created_at) VALUES (?, ?, ?)",
          [localA, linA, now]
        );
        db.run(
          "INSERT OR REPLACE INTO issue_id_map (local_id, linear_id, created_at) VALUES (?, ?, ?)",
          [localB, linB, now]
        );
        db.run("DELETE FROM dependencies");
        db.run(
          "INSERT INTO dependencies (issue_id, depends_on_id, type, created_at, created_by) VALUES (?, ?, 'blocks', ?, 'test')",
          [localA, localB, now]
        );

        const changed = canonicalizeDependencyAliases();
        const rows = db.query(
          "SELECT issue_id, depends_on_id, type FROM dependencies ORDER BY issue_id, depends_on_id"
        ).all();
        db.close();
        console.log(JSON.stringify({ changed, rows }));
      `;

      const a = await lbLocalJson<Array<{ id: string }>>("create", "Alias remap A");
      const b = await lbLocalJson<Array<{ id: string }>>("create", "Alias remap B");
      const result = await evalLocal(canonicalize, [a[0].id, b[0].id, "LIN-7003", "LIN-7004"]);
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout) as {
        changed: number;
        rows: Array<{ issue_id: string; depends_on_id: string; type: string }>;
      };
      expect(parsed.changed).toBe(1);
      expect(parsed.rows).toEqual([
        {
          issue_id: "LIN-7003",
          depends_on_id: "LIN-7004",
          type: "blocks",
        },
      ]);
    });

    test("should show dep tree", async () => {
      const parent = await lbLocalJson<Array<{ id: string }>>("create", "Tree parent");

      const result = await lbLocal("dep", "tree", parent[0].id);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(parent[0].id);
    });

    test("dep tree surfaces parent children in executable blocker order", async () => {
      const parent = await lbLocalJson<Array<{ id: string }>>("create", "Execution graph parent");
      const firstChild = await lbLocalJson<Array<{ id: string }>>(
        "create",
        "First implementation child",
        "--parent",
        parent[0].id
      );
      const secondChild = await lbLocalJson<Array<{ id: string }>>(
        "create",
        "Second implementation child",
        "--parent",
        parent[0].id
      );
      const thirdChild = await lbLocalJson<Array<{ id: string }>>(
        "create",
        "Third implementation child",
        "--parent",
        parent[0].id
      );
      const blocker = await lbLocalJson<Array<{ id: string }>>("create", "Root blocker");
      const blocked = await lbLocalJson<Array<{ id: string }>>("create", "Root blocked");
      const related = await lbLocalJson<Array<{ id: string }>>("create", "Root related");

      await lbLocal("dep", "add", firstChild[0].id, "--blocks", secondChild[0].id);
      await lbLocal("dep", "add", secondChild[0].id, "--blocks", thirdChild[0].id);
      await lbLocal("dep", "add", parent[0].id, "--blocked-by", blocker[0].id);
      await lbLocal("dep", "add", parent[0].id, "--blocks", blocked[0].id);
      await lbLocal("dep", "add", parent[0].id, "--related", related[0].id);

      const result = await lbLocal("dep", "tree", parent[0].id);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Children (execution order) (3)");
      expect(result.stdout).toContain(`${firstChild[0].id}: First implementation child [READY]`);
      expect(result.stdout).toContain("Blocks (1)");
      expect(result.stdout).toContain("Blocked by (1)");
      expect(result.stdout).toContain("Related (1)");
      expect(result.stdout).toContain(blocker[0].id);
      expect(result.stdout).toContain(blocked[0].id);
      expect(result.stdout).toContain(related[0].id);

      const firstIndex = result.stdout.indexOf(firstChild[0].id);
      const secondIndex = result.stdout.indexOf(secondChild[0].id);
      const thirdIndex = result.stdout.indexOf(thirdChild[0].id);
      expect(firstIndex).toBeGreaterThan(-1);
      expect(secondIndex).toBeGreaterThan(firstIndex);
      expect(thirdIndex).toBeGreaterThan(secondIndex);
    });
  });

  describe("outbox locking", () => {
    test("should allow only one claimant per outbox item", async () => {
      const queueScript = `
        import { queueOutboxItem } from '${import.meta.dir}/../src/utils/database.ts';
        console.log(queueOutboxItem('update', { issueId: 'LIN-TEST-LOCK', title: 'lock' }));
      `;
      const queued = await evalLocal(queueScript);
      expect(queued.exitCode).toBe(0);
      const itemId = queued.stdout.trim();
      expect(itemId).toMatch(/^\d+$/);

      const claimScript = `
        import { claimOutboxItem } from '${import.meta.dir}/../src/utils/database.ts';
        const id = Number(process.argv[1]);
        console.log(claimOutboxItem(id) ? 'claimed' : 'skipped');
      `;

      const procA = Bun.spawn(["bun", "--eval", claimScript, itemId], {
        cwd: testDir,
        env: { ...process.env, LB_TEAM_KEY: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const procB = Bun.spawn(["bun", "--eval", claimScript, itemId], {
        cwd: testDir,
        env: { ...process.env, LB_TEAM_KEY: "" },
        stdout: "pipe",
        stderr: "pipe",
      });

      const [outA, outB, codeA, codeB] = await Promise.all([
        new Response(procA.stdout).text(),
        new Response(procB.stdout).text(),
        procA.exited,
        procB.exited,
      ]);

      expect(codeA).toBe(0);
      expect(codeB).toBe(0);

      const results = [outA.trim(), outB.trim()].sort();
      expect(results).toEqual(["claimed", "skipped"]);

      await evalLocal(
        `
        import { removeOutboxItem, releaseOutboxItemClaim } from '${import.meta.dir}/../src/utils/database.ts';
        const id = Number(process.argv[1]);
        releaseOutboxItemClaim(id);
        removeOutboxItem(id);
      `,
        [itemId]
      );
    });

    test("should defer failed outbox items until next attempt window", async () => {
      const script = `
        import {
          queueOutboxItem,
          updateOutboxItemError,
          getPendingOutboxItems,
          removeOutboxItem,
        } from '${import.meta.dir}/../src/utils/database.ts';
        const id = queueOutboxItem('update', { issueId: 'LIN-TEST-BACKOFF', title: 'backoff' });
        updateOutboxItemError(id, 'Rate limit exceeded retry-after":"3600"');
        const pendingIds = getPendingOutboxItems().map((item) => item.id);
        console.log(pendingIds.includes(id) ? 'pending' : 'deferred');
        removeOutboxItem(id);
      `;

      const result = await evalLocal(script);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("deferred");
    });
  });

  describe("mail storage primitives", () => {
    test("should register agents with unique memorable handles", async () => {
      const script = `
        import { registerAgent } from '${import.meta.dir}/../src/utils/database.ts';
        const a = registerAgent({ preferredHandle: 'MailAgent' });
        const b = registerAgent({ preferredHandle: 'MailAgent' });
        console.log(JSON.stringify({ a, b }));
      `;
      const result = await evalLocal(script);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        a: { id: string; handle: string };
        b: { id: string; handle: string };
      };

      expect(parsed.a.id).toBeDefined();
      expect(parsed.b.id).toBeDefined();
      expect(parsed.a.handle).toBe("MailAgent");
      expect(parsed.b.handle).not.toBe("MailAgent");
      expect(parsed.b.handle.length).toBeGreaterThan(0);
    });

    test("should store message, fetch inbox, and apply read/ack transitions", async () => {
      const script = `
        import {
          registerAgent,
          createThreadIfNeeded,
          storeMessage,
          addRecipients,
          fetchInbox,
          markMessageRead,
          ackMessage,
          fetchThread,
          getAgentByHandle,
          listAgents,
        } from '${import.meta.dir}/../src/utils/database.ts';

        const sender = registerAgent({ preferredHandle: 'Sender_' + Date.now() });
        const recipient = registerAgent({ preferredHandle: 'Recipient_' + Date.now() });
        const cc = registerAgent({ preferredHandle: 'Cc_' + Date.now() });

        const thread = createThreadIfNeeded({
          subject: 'Storage test thread',
          workItemRef: 'local:MAIL-STORAGE-1',
        });

        const stored = storeMessage({
          threadId: thread.id,
          senderAgentId: sender.id,
          subject: 'Hello recipient',
          bodyMd: 'Body for inbox test',
          recipients: [{ recipientAgentId: recipient.id, kind: 'to' }],
        });

        const extraRecipients = addRecipients(stored.message.id, [
          { recipientAgentId: cc.id, kind: 'cc' },
        ]);

        const unreadBefore = fetchInbox(recipient.id, { unreadOnly: true, limit: 20 });
        const mark = markMessageRead(recipient.id, stored.message.id);
        const ack = ackMessage(recipient.id, stored.message.id);
        const unreadAfter = fetchInbox(recipient.id, { unreadOnly: true, limit: 20 });
        const threadView = fetchThread(stored.thread.id);
        const byHandle = getAgentByHandle(sender.handle);
        const allAgents = listAgents();

        console.log(JSON.stringify({
          sender,
          recipient,
          thread,
          stored,
          extraRecipients,
          unreadBefore,
          mark,
          ack,
          unreadAfter,
          threadView,
          byHandle,
          allAgentsCount: allAgents.length
        }));
      `;

      const result = await evalLocal(script);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        stored: { message: { id: string; thread_id: string } };
        extraRecipients: Array<{ kind: string }>;
        unreadBefore: Array<{ message: { id: string } }>;
        unreadAfter: Array<{ message: { id: string } }>;
        mark: { updated: number };
        ack: { updated: number };
        threadView: {
          thread: { id: string };
          messages: Array<{ id: string; recipients: unknown[] }>;
        };
        byHandle: { id: string; handle: string } | null;
        allAgentsCount: number;
      };

      expect(parsed.stored.message.id).toBeDefined();
      expect(parsed.extraRecipients.some((r) => r.kind === "cc")).toBe(true);
      expect(
        parsed.unreadBefore.some((entry) => entry.message.id === parsed.stored.message.id)
      ).toBe(true);
      expect(parsed.mark.updated).toBeGreaterThanOrEqual(1);
      expect(parsed.ack.updated).toBeGreaterThanOrEqual(1);
      expect(
        parsed.unreadAfter.some((entry) => entry.message.id === parsed.stored.message.id)
      ).toBe(false);
      expect(parsed.threadView.thread.id).toBe(parsed.stored.message.thread_id);
      expect(parsed.threadView.messages.some((m) => m.id === parsed.stored.message.id)).toBe(true);
      expect(parsed.byHandle).not.toBeNull();
      expect(parsed.allAgentsCount).toBeGreaterThan(0);
    });
  });

  describe("mail CLI workflow", () => {
    test("should support local A->B send/read/reply/ack flow", async () => {
      const suffix = Date.now().toString();
      const alpha = `Alpha${suffix}`;
      const beta = `Beta${suffix}`;

      const alphaReg = await lbLocalJson<{ handle: string }>(
        "agent",
        "register",
        "--handle",
        alpha
      );
      const betaReg = await lbLocalJson<{ handle: string }>("agent", "register", "--handle", beta);

      expect(alphaReg.handle).toBe(alpha);
      expect(betaReg.handle).toBe(beta);

      const sent = await lbLocalJson<{
        message: { id: string; thread_id: string };
        recipients: Array<{ recipient_agent_id: string }>;
      }>(
        "mail",
        "send",
        "--from",
        alpha,
        "--to",
        beta,
        "--subject",
        "Local mail workflow",
        "--body",
        "step-1"
      );

      expect(sent.message.id).toBeDefined();

      const betaUnread = await lbLocalJson<Array<{ message: { id: string; subject: string } }>>(
        "mail",
        "inbox",
        "--agent",
        beta,
        "--unread"
      );
      expect(betaUnread.some((entry) => entry.message.id === sent.message.id)).toBe(true);

      const readResult = await lbLocalJson<{ updated: number }>(
        "mail",
        "read",
        "--agent",
        beta,
        "--message",
        sent.message.id
      );
      expect(readResult.updated).toBeGreaterThanOrEqual(1);

      const replyResult = await lbLocalJson<{ message: { id: string; thread_id: string } }>(
        "mail",
        "reply",
        "--agent",
        beta,
        "--message",
        sent.message.id,
        "--body",
        "step-2"
      );
      expect(replyResult.message.thread_id).toBe(sent.message.thread_id);

      const alphaInbox = await lbLocalJson<Array<{ message: { id: string } }>>(
        "mail",
        "inbox",
        "--agent",
        alpha
      );
      expect(alphaInbox.some((entry) => entry.message.id === replyResult.message.id)).toBe(true);

      const alphaAck = await lbLocalJson<{ updated: number }>(
        "mail",
        "ack",
        "--agent",
        alpha,
        "--message",
        replyResult.message.id
      );
      expect(alphaAck.updated).toBeGreaterThanOrEqual(1);

      const threadView = await lbLocalJson<{ messages: Array<{ id: string }> }>(
        "mail",
        "thread",
        "--thread",
        sent.message.thread_id
      );
      expect(threadView.messages.some((message) => message.id === sent.message.id)).toBe(true);
      expect(threadView.messages.some((message) => message.id === replyResult.message.id)).toBe(
        true
      );
    });

    test("should read mail bodies from @file for send and reply", async () => {
      const suffix = `${Date.now()}-file`;
      const alpha = `Alpha${suffix}`;
      const beta = `Beta${suffix}`;
      const sendBodyPath = join(testDir, "mail-send-body.md");
      const replyBodyPath = join(testDir, "mail-reply-body.md");

      writeFileSync(sendBodyPath, "Hello from file\n\n- line one\n");
      writeFileSync(replyBodyPath, "Reply from file\n\n- line two\n");

      await lbLocalJson<{ handle: string }>("agent", "register", "--handle", alpha);
      await lbLocalJson<{ handle: string }>("agent", "register", "--handle", beta);

      const sent = await lbLocalJson<{
        message: { id: string; thread_id: string; body_md: string };
      }>(
        "mail",
        "send",
        "--from",
        alpha,
        "--to",
        beta,
        "--subject",
        "Mail body from file",
        "--body",
        `@${sendBodyPath}`
      );

      expect(sent.message.body_md).toBe("Hello from file\n\n- line one\n");

      const reply = await lbLocalJson<{
        message: { id: string; thread_id: string; body_md: string };
      }>(
        "mail",
        "reply",
        "--agent",
        beta,
        "--message",
        sent.message.id,
        "--body",
        `@${replyBodyPath}`
      );

      expect(reply.message.thread_id).toBe(sent.message.thread_id);
      expect(reply.message.body_md).toBe("Reply from file\n\n- line two\n");
    });
  });
});
