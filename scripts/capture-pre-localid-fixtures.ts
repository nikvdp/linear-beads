#!/usr/bin/env bun
/**
 * Capture deterministic repository snapshots with the pre-local_id schema model.
 *
 * These fixtures are used to validate migration safety when moving to the
 * stable local_id primary-key model.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";

type SeedFixture = {
  name: string;
  description: string;
  seed: (db: Database) => void;
};

const ISO = "2026-03-01T00:00:00.000Z";

function runCommand(cmd: string[], cwd: string): void {
  const proc = Bun.spawnSync({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      LB_TEAM_KEY: process.env.LB_TEAM_KEY || "LIN",
    },
  });

  if (proc.exitCode !== 0) {
    const stderr = proc.stderr ? Buffer.from(proc.stderr).toString("utf8") : "";
    const stdout = proc.stdout ? Buffer.from(proc.stdout).toString("utf8") : "";
    throw new Error(`Command failed: ${cmd.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
}

function setupRepo(repoRoot: string, repoName: string): string {
  const repoDir = join(repoRoot, repoName);
  mkdirSync(repoDir, { recursive: true });
  runCommand(["git", "init", "-q"], repoDir);

  const configPath = join(repoDir, ".lb", "config.jsonc");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        local_only: true,
        repo_name: repoName,
        repo_scope: "project",
        repo_binding_version: 2,
      },
      null,
      2
    )}\n`
  );

  return repoDir;
}

function initializeSchema(repoDir: string, sourceRoot: string): string {
  runCommand(["bun", "run", join(sourceRoot, "src", "cli.ts"), "list", "--all"], repoDir);
  return join(repoDir, ".lb", "cache.db");
}

function insertIssue(
  db: Database,
  issue: {
    id: string;
    title: string;
    description?: string;
    status: string;
    priority: number;
    issueType?: string;
    syncStatus: "synced" | "pending" | "failed";
  }
): void {
  db.run(
    `
      INSERT OR REPLACE INTO issues
      (id, identifier, title, description, status, priority, issue_type, sync_status, created_at, updated_at, closed_at, assignee, linear_state_id, cached_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, datetime('now'))
    `,
    [
      issue.id,
      issue.id,
      issue.title,
      issue.description || null,
      issue.status,
      issue.priority,
      issue.issueType || null,
      issue.syncStatus,
      ISO,
      ISO,
    ]
  );
}

function seedSyncedOnly(db: Database): void {
  insertIssue(db, {
    id: "LIN-9001",
    title: "Fixture synced root",
    description: "Synced issue from pre-localid schema",
    status: "open",
    priority: 2,
    syncStatus: "synced",
  });

  insertIssue(db, {
    id: "LIN-9002",
    title: "Fixture synced child",
    description: "Another synced issue",
    status: "in_progress",
    priority: 1,
    syncStatus: "synced",
  });

  db.run(
    `
      INSERT OR REPLACE INTO dependencies (issue_id, depends_on_id, type, created_at, created_by)
      VALUES (?, ?, ?, ?, ?)
    `,
    ["LIN-9002", "LIN-9001", "parent-child", ISO, "fixture"]
  );

  db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync', ?)", [ISO]);
}

function seedPendingOutbox(db: Database): void {
  insertIssue(db, {
    id: "LIN-9100",
    title: "Fixture existing synced blocker",
    description: "Existing synced issue",
    status: "open",
    priority: 2,
    syncStatus: "synced",
  });

  insertIssue(db, {
    id: "LOCAL-0001",
    title: "Fixture pending create",
    description: "Pending issue queued in outbox",
    status: "open",
    priority: 3,
    syncStatus: "pending",
  });

  db.run(
    `
      INSERT OR REPLACE INTO dependencies (issue_id, depends_on_id, type, created_at, created_by)
      VALUES (?, ?, ?, ?, ?)
    `,
    ["LOCAL-0001", "LIN-9100", "parent-child", ISO, "fixture"]
  );

  const payload = JSON.stringify({
    title: "Fixture pending create",
    description: "Pending issue queued in outbox",
    priority: 3,
    parentId: "LIN-9100",
    assign: undefined,
    unassign: false,
    deps: "parent-child:LIN-9100",
  });

  db.run(
    `
      INSERT INTO outbox (operation, payload, local_id, created_at, processing, retry_count, last_error)
      VALUES (?, ?, ?, ?, 0, 0, NULL)
    `,
    ["create", payload, "LOCAL-0001", ISO]
  );
}

function seedMappedLocalAlias(db: Database): void {
  insertIssue(db, {
    id: "LIN-9200",
    title: "Fixture issue previously replaced from local id",
    description: "Represents old replaceIssueId behavior",
    status: "open",
    priority: 2,
    syncStatus: "synced",
  });

  db.run(
    `
      INSERT OR REPLACE INTO issue_id_map (local_id, linear_id, created_at)
      VALUES (?, ?, ?)
    `,
    ["LOCAL-0999", "LIN-9200", ISO]
  );

  insertIssue(db, {
    id: "LIN-9201",
    title: "Fixture dependency peer",
    description: "Dependency references linear ids pre-refactor",
    status: "open",
    priority: 2,
    syncStatus: "synced",
  });

  db.run(
    `
      INSERT OR REPLACE INTO dependencies (issue_id, depends_on_id, type, created_at, created_by)
      VALUES (?, ?, ?, ?, ?)
    `,
    ["LIN-9200", "LIN-9201", "related", ISO, "fixture"]
  );
}

function snapshotFixture(
  sourceRoot: string,
  tmpRoot: string,
  outputDir: string,
  fixture: SeedFixture
): { archive: string; userVersion: number } {
  const repoDir = setupRepo(tmpRoot, fixture.name);
  const dbPath = initializeSchema(repoDir, sourceRoot);
  const db = new Database(dbPath);
  fixture.seed(db);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const versionRow = db.query("PRAGMA user_version").get() as { user_version: number };
  db.close();

  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (existsSync(walPath)) {
    rmSync(walPath, { force: true });
  }
  if (existsSync(shmPath)) {
    rmSync(shmPath, { force: true });
  }

  const archiveName = `${fixture.name}.tar.gz`;
  const archivePath = join(outputDir, archiveName);
  runCommand(["tar", "-czf", archivePath, "-C", tmpRoot, fixture.name], sourceRoot);

  return {
    archive: archiveName,
    userVersion: versionRow.user_version,
  };
}

function main(): void {
  const sourceRoot = process.cwd();
  const outputDir = join(sourceRoot, "test", "fixtures", "pre-localid");

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const tmpRoot = mkdtempSync(join(tmpdir(), "lb-pre-localid-fixtures-"));

  const fixtures: SeedFixture[] = [
    {
      name: "pre-localid-synced-only",
      description: "Synced-only cache with parent-child dependencies.",
      seed: seedSyncedOnly,
    },
    {
      name: "pre-localid-pending-outbox",
      description: "Pending LOCAL issue with queued create outbox payload.",
      seed: seedPendingOutbox,
    },
    {
      name: "pre-localid-mapped-local-alias",
      description: "Legacy local->LIN mapping via issue_id_map after PK replacement behavior.",
      seed: seedMappedLocalAlias,
    },
  ];

  const manifest = {
    captured_at: new Date().toISOString(),
    fixtures: fixtures.map((fixture) => {
      const result = snapshotFixture(sourceRoot, tmpRoot, outputDir, fixture);
      return {
        name: fixture.name,
        archive: result.archive,
        schema_user_version: result.userVersion,
        description: fixture.description,
      };
    }),
  };

  writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // Emit a stable summary for the caller.
  const manifestText = readFileSync(join(outputDir, "manifest.json"), "utf8");
  process.stdout.write(manifestText);

  rmSync(tmpRoot, { recursive: true, force: true });
}

main();
