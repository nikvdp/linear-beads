/**
 * SQLite database for local cache and outbox queue
 * Uses bun:sqlite for Bun compatibility
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { getDbPath } from "./config.js";
import { requestJsonlExport } from "./jsonl-scheduler.js";
import type { Issue, Dependency, OutboxItem } from "../types.js";

let db: Database | null = null;

/**
 * Get database singleton, initializing schema if needed
 */
export function getDatabase(): Database {
  if (!db) {
    const dbPath = getDbPath();
    const dbDir = dirname(dbPath);

    // Ensure directory exists
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    initSchema(db);
  }
  return db;
}

/**
 * Initialize database schema
 */
function initSchema(db: Database): void {
  // Check schema version and migrate if needed
  const versionRow = db.query("PRAGMA user_version").get() as { user_version: number };
  const currentVersion = versionRow?.user_version || 0;

  if (currentVersion < 1) {
    // Initial schema or migration from v0
    db.exec(`
      -- Issues cache
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        issue_type TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        assignee TEXT,
        linear_state_id TEXT,
        cached_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_issues_identifier ON issues(identifier);
      CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
      CREATE INDEX IF NOT EXISTS idx_issues_cached_at ON issues(cached_at);
    `);

    // Migrate existing issue_type column to allow NULL if needed
    // SQLite doesn't support ALTER COLUMN, so we need to recreate the table
    // Check if we have the old NOT NULL constraint
    const tableInfo = db.query("PRAGMA table_info(issues)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const issueTypeCol = tableInfo.find((c) => c.name === "issue_type");
    if (issueTypeCol && issueTypeCol.notnull === 1) {
      // Need to migrate - recreate table without NOT NULL on issue_type
      db.exec(`
        -- Migrate issue_type to nullable
        CREATE TABLE issues_new (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL,
          issue_type TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          closed_at TEXT,
          assignee TEXT,
          linear_state_id TEXT,
          cached_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO issues_new SELECT * FROM issues;
        DROP TABLE issues;
        ALTER TABLE issues_new RENAME TO issues;
        CREATE INDEX idx_issues_identifier ON issues(identifier);
        CREATE INDEX idx_issues_status ON issues(status);
        CREATE INDEX idx_issues_cached_at ON issues(cached_at);
      `);
    }

    db.exec("PRAGMA user_version = 1");
  }

  // Continue with rest of schema (these are idempotent with IF NOT EXISTS)
  db.exec(`

    -- Dependencies/relations cache
    CREATE TABLE IF NOT EXISTS dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT NOT NULL,
      depends_on_id TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      UNIQUE(issue_id, depends_on_id, type)
    );

    CREATE INDEX IF NOT EXISTS idx_deps_issue_id ON dependencies(issue_id);
    CREATE INDEX IF NOT EXISTS idx_deps_depends_on_id ON dependencies(depends_on_id);

    -- Labels cache (for repo scoping)
    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      team_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_labels_name ON labels(name);

    -- Outbox queue for pending mutations
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    -- Metadata (cache timestamps, etc.)
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

/**
 * Check if cache is stale
 */
export function isCacheStale(ttlSeconds: number = 120): boolean {
  const db = getDatabase();
  const row = db.query("SELECT value FROM metadata WHERE key = 'last_sync'").get() as {
    value: string;
  } | null;

  if (!row) return true;

  const lastSync = new Date(row.value);
  const now = new Date();
  const diffSeconds = (now.getTime() - lastSync.getTime()) / 1000;

  return diffSeconds > ttlSeconds;
}

/**
 * Update last sync timestamp
 */
export function updateLastSync(): void {
  const db = getDatabase();
  db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync', datetime('now'))");
  requestJsonlExport();
}

/**
 * Cache an issue
 */
export function cacheIssue(issue: Issue & { linear_state_id?: string }): void {
  const db = getDatabase();
  db.run(
    `
    INSERT OR REPLACE INTO issues 
    (id, identifier, title, description, status, priority, issue_type, created_at, updated_at, closed_at, assignee, linear_state_id, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `,
    [
      issue.id,
      issue.id, // identifier same as id for now
      issue.title,
      issue.description || null,
      issue.status,
      issue.priority,
      issue.issue_type || null,
      issue.created_at,
      issue.updated_at,
      issue.closed_at || null,
      issue.assignee || null,
      issue.linear_state_id || null,
    ]
  );
  requestJsonlExport();
}

/**
 * Cache multiple issues (transactional)
 */
export function cacheIssues(issues: Array<Issue & { linear_state_id?: string }>): void {
  const db = getDatabase();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO issues 
    (id, identifier, title, description, status, priority, issue_type, created_at, updated_at, closed_at, assignee, linear_state_id, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const transaction = db.transaction(() => {
    for (const issue of issues) {
      insert.run(
        issue.id,
        issue.id,
        issue.title,
        issue.description || null,
        issue.status,
        issue.priority,
        issue.issue_type || null,
        issue.created_at,
        issue.updated_at,
        issue.closed_at || null,
        issue.assignee || null,
        issue.linear_state_id || null
      );
    }
  });

  transaction();
  requestJsonlExport();
}

/**
 * Get cached issue by ID
 */
export function getCachedIssue(id: string): Issue | null {
  const db = getDatabase();
  const row = db.query("SELECT * FROM issues WHERE id = ? OR identifier = ?").get(id, id) as Record<
    string,
    unknown
  > | null;

  if (!row) return null;

  const issue: Issue = {
    id: row.id as string,
    title: row.title as string,
    description: row.description as string | undefined,
    status: row.status as Issue["status"],
    priority: row.priority as Issue["priority"],
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    closed_at: row.closed_at as string | undefined,
    assignee: row.assignee as string | undefined,
  };

  if (row.issue_type) {
    issue.issue_type = row.issue_type as Issue["issue_type"];
  }

  return issue;
}

/**
 * Get all cached issues
 */
export function getCachedIssues(): Issue[] {
  const db = getDatabase();
  const rows = db.query("SELECT * FROM issues ORDER BY updated_at DESC").all() as Array<
    Record<string, unknown>
  >;

  return rows.map((row) => {
    const issue: Issue = {
      id: row.id as string,
      title: row.title as string,
      description: row.description as string | undefined,
      status: row.status as Issue["status"],
      priority: row.priority as Issue["priority"],
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      closed_at: row.closed_at as string | undefined,
      assignee: row.assignee as string | undefined,
    };

    if (row.issue_type) {
      issue.issue_type = row.issue_type as Issue["issue_type"];
    }

    return issue;
  });
}

/**
 * Cache a dependency
 */
export function cacheDependency(dep: Dependency): void {
  const db = getDatabase();
  db.run(
    `
    INSERT OR REPLACE INTO dependencies 
    (issue_id, depends_on_id, type, created_at, created_by)
    VALUES (?, ?, ?, ?, ?)
  `,
    [dep.issue_id, dep.depends_on_id, dep.type, dep.created_at, dep.created_by]
  );
  requestJsonlExport();
}

/**
 * Clear all dependencies for an issue (before re-syncing)
 */
export function clearIssueDependencies(issueId: string): void {
  const db = getDatabase();
  db.run("DELETE FROM dependencies WHERE issue_id = ?", [issueId]);
  requestJsonlExport();
}

/**
 * Get dependencies for an issue
 */
export function getDependencies(issueId: string): Dependency[] {
  const db = getDatabase();
  const rows = db.query("SELECT * FROM dependencies WHERE issue_id = ?").all(issueId) as Array<
    Record<string, unknown>
  >;

  return rows.map((row) => ({
    issue_id: row.issue_id as string,
    depends_on_id: row.depends_on_id as string,
    type: row.type as Dependency["type"],
    created_at: row.created_at as string,
    created_by: row.created_by as string,
  }));
}

/**
 * Get issues that depend on this issue (dependents)
 */
export function getDependents(issueId: string): Dependency[] {
  const db = getDatabase();
  const rows = db.query("SELECT * FROM dependencies WHERE depends_on_id = ?").all(issueId) as Array<
    Record<string, unknown>
  >;

  return rows.map((row) => ({
    issue_id: row.issue_id as string,
    depends_on_id: row.depends_on_id as string,
    type: row.type as Dependency["type"],
    created_at: row.created_at as string,
    created_by: row.created_by as string,
  }));
}

/**
 * Get issues that are blocked by open issues
 * Also includes children of blocked issues (they inherit blocking from parent)
 */
export function getBlockedIssueIds(): Set<string> {
  const db = getDatabase();

  // Direct blocks: if dep = {issue_id: A, depends_on_id: B, type: blocks}, then A blocks B
  const directlyBlocked = db
    .query(
      `
    SELECT DISTINCT d.depends_on_id as blocked_id
    FROM dependencies d
    JOIN issues i ON d.issue_id = i.id
    WHERE d.type = 'blocks' AND i.status != 'closed'
  `
    )
    .all() as Array<{ blocked_id: string }>;

  const blocked = new Set(directlyBlocked.map((r) => r.blocked_id));

  // Recursively add children of blocked issues
  // Children have parent-child dep where child.depends_on_id = parent.id
  let added = true;
  while (added) {
    added = false;
    const children = db
      .query(
        `
      SELECT DISTINCT d.issue_id as child_id
      FROM dependencies d
      WHERE d.type = 'parent-child' AND d.depends_on_id IN (${[...blocked].map(() => "?").join(",") || "''"})
    `
      )
      .all(...blocked) as Array<{ child_id: string }>;

    for (const child of children) {
      if (!blocked.has(child.child_id)) {
        blocked.add(child.child_id);
        added = true;
      }
    }
  }

  return blocked;
}

/**
 * Add item to outbox queue
 */
export function queueOutboxItem(
  operation: OutboxItem["operation"],
  payload: Record<string, unknown>
): number {
  const db = getDatabase();
  db.run(
    `
    INSERT INTO outbox (operation, payload)
    VALUES (?, ?)
  `,
    [operation, JSON.stringify(payload)]
  );

  // Get last insert rowid
  const result = db.query("SELECT last_insert_rowid() as id").get() as { id: number };
  return result.id;
}

/**
 * Get pending outbox items
 */
export function getPendingOutboxItems(): OutboxItem[] {
  const db = getDatabase();
  const rows = db.query("SELECT * FROM outbox ORDER BY id ASC").all() as Array<
    Record<string, unknown>
  >;

  return rows.map((row) => ({
    id: row.id as number,
    operation: row.operation as OutboxItem["operation"],
    payload: JSON.parse(row.payload as string),
    created_at: row.created_at as string,
    retry_count: row.retry_count as number,
    last_error: row.last_error as string | undefined,
  }));
}

/**
 * Remove item from outbox (after successful sync)
 */
export function removeOutboxItem(id: number): void {
  const db = getDatabase();
  db.run("DELETE FROM outbox WHERE id = ?", [id]);
}

/**
 * Update outbox item with error
 */
export function updateOutboxItemError(id: number, error: string): void {
  const db = getDatabase();
  db.run(
    `
    UPDATE outbox 
    SET retry_count = retry_count + 1, last_error = ?
    WHERE id = ?
  `,
    [error, id]
  );
}

/**
 * Clear cached data for sync refresh
 * Preserves blocks/related dependencies (only cleared by individual --sync)
 */
export function clearCache(): void {
  const db = getDatabase();
  db.exec(`
    DELETE FROM issues;
    DELETE FROM dependencies WHERE type = 'parent-child';
    DELETE FROM labels;
    DELETE FROM metadata;
  `);
  requestJsonlExport();
}

/**
 * Clear issues cache (before full sync to remove stale issues from other repos)
 */
export function clearIssuesCache(): void {
  const db = getDatabase();
  db.exec(`
    DELETE FROM issues;
    DELETE FROM dependencies WHERE type = 'parent-child';
  `);
  requestJsonlExport();
}

/**
 * Cache a label
 */
export function cacheLabel(id: string, name: string, teamId?: string): void {
  const db = getDatabase();
  db.run(
    `
    INSERT OR REPLACE INTO labels (id, name, team_id)
    VALUES (?, ?, ?)
  `,
    [id, name, teamId || null]
  );
}

/**
 * Get label ID by name
 */
export function getLabelIdByName(name: string): string | null {
  const db = getDatabase();
  const row = db.query("SELECT id FROM labels WHERE name = ?").get(name) as { id: string } | null;
  return row?.id || null;
}

/**
 * Close database
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
