import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const DATABASE_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "database.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): { repoDir: string; dbPath: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-linear-prune-"));
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
  writeFileSync(join(repoDir, ".lb", "config.jsonc"), "{}\n");

  return {
    repoDir,
    dbPath: join(repoDir, ".lb", "cache.db"),
  };
}

async function runInlineCli(
  cwd: string,
  args: string[],
  setupSource: string,
  envOverrides: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    ${setupSource}
    process.argv = ["bun", "lb", ${args.map((arg) => JSON.stringify(arg)).join(", ")}];
    await import(${JSON.stringify(CLI_PATH)});
  `;

  const proc = Bun.spawn(["bun", "--eval", script], {
    cwd,
    env: {
      ...process.env,
      LB_TEAM_KEY: "",
      ...envOverrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function runPruneStale(cwd: string): Promise<{ pruned: number }> {
  const script = `
    import { pruneStaleIssues } from ${JSON.stringify(DATABASE_UTILS_PATH)};
    console.log(JSON.stringify({ pruned: pruneStaleIssues(new Set()) }));
  `;

  const proc = Bun.spawn(["bun", "--eval", script], {
    cwd,
    env: {
      ...process.env,
      LB_TEAM_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`pruneStaleIssues helper failed: ${stderr}`);
  }

  return JSON.parse(stdout) as { pruned: number };
}

function readArchivedRow(dbPath: string, localId: string): {
  local_id: string;
  title: string;
  remote_archived_at: string | null;
} | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query("SELECT local_id, title, remote_archived_at FROM issues WHERE local_id = ?")
      .get(localId) as {
      local_id: string;
      title: string;
      remote_archived_at: string | null;
    } | null;
  } finally {
    db.close();
  }
}

describe("linear prune command", () => {
  test("previews only closed synced Linear issues", async () => {
    const { repoDir } = createRepo();
    const setupSource = `
      import { cacheIssue } from ${JSON.stringify(DATABASE_UTILS_PATH)};

      const now = new Date().toISOString();
      cacheIssue({
        id: "LIN-100",
        local_id: "LOCAL-100",
        linear_id: "issue-100",
        linear_identifier: "LIN-100",
        title: "Already done",
        status: "closed",
        priority: 2,
        sync_status: "synced",
        created_at: now,
        updated_at: now,
        closed_at: now,
      });
      cacheIssue({
        id: "LIN-101",
        local_id: "LOCAL-101",
        linear_id: "issue-101",
        linear_identifier: "LIN-101",
        title: "Still active",
        status: "open",
        priority: 2,
        sync_status: "synced",
        created_at: now,
        updated_at: now,
      });
    `;

    const result = await runInlineCli(repoDir, ["linear", "prune", "--json"], setupSource);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      preview: boolean;
      apply_required: boolean;
      count: number;
      candidates: Array<{ id: string; title: string; status: string }>;
    };

    expect(payload.preview).toBe(true);
    expect(payload.apply_required).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0]).toMatchObject({
      id: "LIN-100",
      title: "Already done",
      status: "closed",
    });
  });

  test("archives the selected issue remotely and preserves it across stale pruning", async () => {
    const { repoDir, dbPath } = createRepo();
    const setupSource = `
      import { cacheIssue } from ${JSON.stringify(DATABASE_UTILS_PATH)};

      const now = new Date().toISOString();
      cacheIssue({
        id: "LIN-200",
        local_id: "LOCAL-200",
        linear_id: "issue-200",
        linear_identifier: "LIN-200",
        title: "Archive me",
        status: "closed",
        priority: 2,
        sync_status: "synced",
        created_at: now,
        updated_at: now,
        closed_at: now,
      });

      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        if (String(body.query || "").includes("issueArchive")) {
          return new Response(
            JSON.stringify({
              data: {
                issueArchive: {
                  success: true,
                },
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          );
        }

        throw new Error("Unexpected GraphQL request: " + JSON.stringify(body));
      };
    `;

    const result = await runInlineCli(
      repoDir,
      ["linear", "prune", "LIN-200", "--yes", "--json"],
      setupSource,
      { LINEAR_API_KEY: "linear-test-key" }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      preview: boolean;
      count: number;
      cleared_remote_pause: boolean;
      archived: Array<{ id: string; title: string }>;
    };

    expect(payload.preview).toBe(false);
    expect(payload.count).toBe(1);
    expect(payload.cleared_remote_pause).toBe(true);
    expect(payload.archived).toHaveLength(1);
    expect(payload.archived[0]).toMatchObject({ id: "LIN-200", title: "Archive me" });

    const archivedRow = readArchivedRow(dbPath, "LOCAL-200");
    expect(archivedRow?.title).toBe("Archive me");
    expect(archivedRow?.remote_archived_at).toBeTruthy();

    const stalePrune = await runPruneStale(repoDir);
    expect(stalePrune.pruned).toBe(0);

    const preservedRow = readArchivedRow(dbPath, "LOCAL-200");
    expect(preservedRow?.local_id).toBe("LOCAL-200");
    expect(preservedRow?.remote_archived_at).toBeTruthy();
  });
});
