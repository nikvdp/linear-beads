/**
 * Integration tests for lb CLI
 *
 * Requires:
 * - LINEAR_API_KEY environment variable
 * - LB_TEAM_KEY environment variable (or uses LIN as default)
 *
 * Run with: bun test test/integration.test.ts
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
import { GraphQLClient } from "graphql-request";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// Increase timeout for API calls
setDefaultTimeout(30000);

const TEAM_KEY = process.env.LB_TEAM_KEY || "LIN";
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

describe("lb CLI Integration Tests", () => {
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
        }>
      >("create", title, "-p", "1");

      expect(result[0].id).toBe("pending");
      expect(result[0].title).toBe(title);

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
      // First create a queued issue (no --sync, so it queues)
      await lb("create", `${TEST_PREFIX} Sync test`);

      // Then sync
      const result = await lbJson<{
        pushed: { success: number; failed: number };
        pulled: number;
      }>("sync");

      expect(result.pushed.success).toBeGreaterThanOrEqual(1);
      expect(result.pushed.failed).toBe(0);
      expect(result.pulled).toBeGreaterThanOrEqual(0);
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
      // Create an issue first
      const createResult = await lbJson<Array<{ id: string }>>(
        "create",
        `${TEST_PREFIX} Show test`,
        "-d",
        "Test description",
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
      const createResult = await lbJson<Array<{ id: string; title: string }>>("create", title);

      // Should return immediately with pending ID
      expect(createResult[0].id).toBe("pending");
      expect(createResult[0].title).toBe(title);

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
describe("Project Scoping Mode", () => {
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

    test("should remove dependency", async () => {
      const a = await lbLocalJson<Array<{ id: string }>>("create", "Remove A");
      const b = await lbLocalJson<Array<{ id: string }>>("create", "Remove B");

      await lbLocal("dep", "add", a[0].id, "--blocks", b[0].id);
      await lbLocal("dep", "remove", a[0].id, b[0].id);

      // Verify removed
      const show = await lbLocalJson<Array<{ blocks?: string[] }>>("show", a[0].id);
      expect(show[0].blocks || []).not.toContain(b[0].id);
    });

    test("should show dep tree", async () => {
      const parent = await lbLocalJson<Array<{ id: string }>>("create", "Tree parent");

      const result = await lbLocal("dep", "tree", parent[0].id);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(parent[0].id);
    });
  });
});
