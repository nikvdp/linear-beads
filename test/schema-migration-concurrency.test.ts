import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const FIXTURE_DIR = join(import.meta.dir, "fixtures", "pre-localid");
const FIXTURE_ARCHIVE = join(FIXTURE_DIR, "pre-localid-pending-outbox.tar.gz");
const FIXTURE_NAME = "pre-localid-pending-outbox";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function extractFixture(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "lb-schema-race-"));
  tempDirs.push(tempDir);

  const untar = Bun.spawnSync(["tar", "-xzf", FIXTURE_ARCHIVE, "-C", tempDir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (untar.exitCode !== 0) {
    const stderr = untar.stderr ? Buffer.from(untar.stderr).toString("utf8") : "";
    throw new Error(`Failed to extract fixture: ${stderr}`);
  }

  return join(tempDir, FIXTURE_NAME);
}

async function runLb(cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, "list", "--all", "--json"], {
    cwd,
    env: { ...process.env, LB_TEAM_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("schema migration concurrency", () => {
  test("parallel startup calls do not race during legacy schema migration", async () => {
    const repoDir = extractFixture();

    const [a, b] = await Promise.all([runLb(repoDir), runLb(repoDir)]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stderr).toBe("");
    expect(b.stderr).toBe("");

    const dbPath = join(repoDir, ".lb", "cache.db");
    const db = new Database(dbPath, { readonly: true });
    const version = db.query("PRAGMA user_version").get() as { user_version: number };
    const outboxColumns = db.query("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
    db.close();

    expect(version.user_version).toBe(7);
    expect(outboxColumns.some((column) => column.name === "remote_issue_identifier")).toBe(true);

    // Ensure the command output is valid JSON (no half-migrated crash output).
    expect(Array.isArray(JSON.parse(a.stdout))).toBe(true);
    expect(Array.isArray(JSON.parse(b.stdout))).toBe(true);
  });
});
