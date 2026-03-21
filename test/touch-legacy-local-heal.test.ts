import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { touchCommand } from "../src/commands/touch.js";
import {
  cacheIssue,
  closeDatabase,
  getIssueSyncKey,
  setIssueIdMapping,
} from "../src/utils/database.js";
import { reloadConfig } from "../src/utils/config.js";
import { resetGraphQLClient } from "../src/utils/graphql.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
  });
}

function createTempGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (init.exitCode !== 0) {
    throw new Error("Failed to initialize temp git repo");
  }

  return dir;
}

function writeRepoConfig(repoDir: string, config: Record<string, unknown>): void {
  const lbDir = join(repoDir, ".lb");
  mkdirSync(lbDir, { recursive: true });
  writeFileSync(join(lbDir, "config.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
}

async function runTouchCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => stdout.push(parts.join(" "));
  console.error = (...parts) => stderr.push(parts.join(" "));

  try {
    const program = new Command();
    program.exitOverride();
    program.addCommand(touchCommand);
    await program.parseAsync(["touch", ...args], { from: "user" });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return {
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
  };
}

describe("touch legacy LOCAL ref healing", () => {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.LINEAR_API_KEY;
  let tempDir: string | null = null;

  beforeEach(() => {
    resetGraphQLClient();
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    resetGraphQLClient();
    process.chdir(originalCwd);
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.LINEAR_API_KEY;
    } else {
      process.env.LINEAR_API_KEY = originalApiKey;
    }
    reloadConfig();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("touch heals resolvable plain LOCAL refs even when older synced rows are missing sync_key", async () => {
    tempDir = createTempGitRepo("lb-touch-legacy-local");
    process.chdir(tempDir);
    writeRepoConfig(tempDir, {
      issue_backend: "linear",
      team_key: "CCO",
    });
    process.env.LINEAR_API_KEY = "test-linear-api-key";
    reloadConfig();

    const now = "2026-03-21T09:24:54.568Z";
    cacheIssue({
      id: "LIN-5576",
      title: "Touch subject",
      description: undefined,
      status: "backlog",
      priority: 2,
      sync_status: "synced",
      created_at: now,
      updated_at: now,
    });
    cacheIssue({
      id: "LIN-5329",
      title: "Strict-mode epic",
      description: undefined,
      status: "open",
      priority: 2,
      sync_status: "synced",
      created_at: now,
      updated_at: now,
    });
    cacheIssue({
      id: "LIN-5330",
      title: "Strict-mode spec",
      description: undefined,
      status: "open",
      priority: 2,
      sync_status: "synced",
      created_at: now,
      updated_at: now,
    });
    setIssueIdMapping("LOCAL-018", "LIN-5329");
    setIssueIdMapping("LOCAL-019", "LIN-5330");

    let capturedDescription = "";
    globalThis.fetch = (async (_input, init) => {
      const payload = JSON.parse(String(init?.body || "{}")) as {
        query?: string;
        variables?: Record<string, unknown>;
      };

      if (payload.query?.includes("query GetTeam")) {
        return jsonResponse({
          data: {
            teams: {
              nodes: [{ id: "team-cco", key: "CCO", name: "cco" }],
            },
          },
        });
      }

      if (payload.query?.includes("query GetIssueDescriptionForHeal")) {
        return jsonResponse({
          data: {
            issue: {
              description: [
                "Sources",
                "",
                "* Related strict-mode epic: LOCAL-018",
                "* Related spec ticket: LOCAL-019",
              ].join("\n"),
            },
          },
        });
      }

      if (payload.query?.includes("query GetWorkspaceUrlKey")) {
        return jsonResponse({
          data: {
            viewer: {
              url: "https://linear.app/linear-beads",
              organization: { urlKey: "linear-beads" },
            },
          },
        });
      }

      if (payload.query?.includes("mutation UpdateIssue")) {
        const input = payload.variables?.input as { description?: string } | undefined;
        capturedDescription = input?.description || "";
        return jsonResponse({
          data: {
            issueUpdate: {
              success: true,
              issue: {
                id: "628061c4-e1d9-489f-820d-a207d25163aa",
                identifier: "LIN-5576",
                title: "Touch subject",
                description: capturedDescription,
                priority: 2,
                createdAt: now,
                updatedAt: "2026-03-21T09:55:54.360Z",
                completedAt: null,
                canceledAt: null,
                state: {
                  id: "state-backlog",
                  name: "Backlog",
                  type: "backlog",
                },
                labels: { nodes: [] },
                assignee: null,
                parent: null,
              },
            },
          },
        });
      }

      throw new Error(`Unexpected GraphQL query: ${payload.query}`);
    }) as typeof fetch;

    const result = await runTouchCli("LIN-5576", "--json");
    expect(result.stderr).toBe("");

    const parsed = JSON.parse(result.stdout) as Array<{ description?: string }>;
    expect(parsed[0]?.description).toContain(
      "Related strict-mode epic: <https://linear.app/linear-beads/issue/LIN-5329>"
    );
    expect(parsed[0]?.description).toContain(
      "Related spec ticket: <https://linear.app/linear-beads/issue/LIN-5330>"
    );
    expect(parsed[0]?.description).not.toContain("LOCAL-018");
    expect(parsed[0]?.description).not.toContain("LOCAL-019");

    expect(capturedDescription).toContain(
      "* Related strict-mode epic: <https://linear.app/linear-beads/issue/LIN-5329>"
    );
    expect(capturedDescription).toContain(
      "* Related spec ticket: <https://linear.app/linear-beads/issue/LIN-5330>"
    );
    expect(getIssueSyncKey("LIN-5329")).toBeTruthy();
    expect(getIssueSyncKey("LIN-5330")).toBeTruthy();
  });
});
