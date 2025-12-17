/**
 * Integration tests for lb CLI
 *
 * Requires:
 * - LINEAR_API_KEY environment variable
 * - LB_TEAM_KEY environment variable (or uses LIN as default)
 *
 * Run with: bun test test/integration.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";

// Increase timeout for API calls
setDefaultTimeout(30000);

const TEAM_KEY = process.env.LB_TEAM_KEY || "LIN";
const TEST_PREFIX = `[test-${Date.now()}]`;

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
    // Sync first to push any pending items
    await lb("sync");

    // Get all issues with our test prefix
    const allIssues = await lbJson<Array<{ id: string; title: string; status: string }>>("list");

    // Close all test issues that aren't already closed
    for (const issue of allIssues) {
      if (issue.title.includes(TEST_PREFIX) && issue.status !== "closed") {
        try {
          await lb("close", issue.id, "--reason", "Integration test cleanup", "--sync");
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    // Final sync to ensure cleanup is complete
    await lb("sync");
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
      const createResult = await lbJson<Array<{ id: string; title: string }>>(
        "create",
        title
      );

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
