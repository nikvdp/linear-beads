/**
 * SQLite database for local cache and outbox queue
 * Uses bun:sqlite for Bun compatibility
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { getDbPath } from "./config.js";
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
  db.exec(`
    -- Issues cache
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      issue_type TEXT NOT NULL,
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
  const row = db
    .query("SELECT value FROM metadata WHERE key = 'last_sync'")
    .get() as { value: string } | null;
  
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
  db.run(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync', datetime('now'))"
  );
}

/**
 * Cache an issue
 */
export function cacheIssue(issue: Issue & { linear_state_id?: string }): void {
  const db = getDatabase();
  db.run(`
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
      issue.issue_type,
      issue.created_at,
      issue.updated_at,
      issue.closed_at || null,
      issue.assignee || null,
      issue.linear_state_id || null,
    ]
  );
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
        issue.issue_type,
        issue.created_at,
        issue.updated_at,
        issue.closed_at || null,
        issue.assignee || null,
        issue.linear_state_id || null
      );
    }
  });

  transaction();
}

/**
 * Get cached issue by ID
 */
export function getCachedIssue(id: string): Issue | null {
  const db = getDatabase();
  const row = db.query("SELECT * FROM issues WHERE id = ? OR identifier = ?").get(id, id) as Record<string, unknown> | null;
  
  if (!row) return null;

  return {
    id: row.id as string,
    title: row.title as string,
    description: row.description as string | undefined,
    status: row.status as Issue["status"],
    priority: row.priority as Issue["priority"],
    issue_type: row.issue_type as Issue["issue_type"],
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    closed_at: row.closed_at as string | undefined,
    assignee: row.assignee as string | undefined,
  };
}

/**
 * Get all cached issues
 */
export function getCachedIssues(): Issue[] {
  const db = getDatabase();
  const rows = db.query("SELECT * FROM issues ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>;
  
  return rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    description: row.description as string | undefined,
    status: row.status as Issue["status"],
    priority: row.priority as Issue["priority"],
    issue_type: row.issue_type as Issue["issue_type"],
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    closed_at: row.closed_at as string | undefined,
    assignee: row.assignee as string | undefined,
  }));
}

/**
 * Cache a dependency
 */
export function cacheDependency(dep: Dependency): void {
  const db = getDatabase();
  db.run(`
    INSERT OR REPLACE INTO dependencies 
    (issue_id, depends_on_id, type, created_at, created_by)
    VALUES (?, ?, ?, ?, ?)
  `, [dep.issue_id, dep.depends_on_id, dep.type, dep.created_at, dep.created_by]);
}

/**
 * Get dependencies for an issue
 */
export function getDependencies(issueId: string): Dependency[] {
  const db = getDatabase();
  const rows = db.query("SELECT * FROM dependencies WHERE issue_id = ?").all(issueId) as Array<Record<string, unknown>>;
  
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
  const rows = db.query("SELECT * FROM dependencies WHERE depends_on_id = ?").all(issueId) as Array<Record<string, unknown>>;
  
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
 */
export function getBlockedIssueIds(): Set<string> {
  const db = getDatabase();
  // An issue is blocked if it has a "blocks" dependency on an open issue
  const rows = db.query(`
    SELECT DISTINCT d.issue_id
    FROM dependencies d
    JOIN issues i ON d.depends_on_id = i.id
    WHERE d.type = 'blocks' AND i.status != 'closed'
  `).all() as Array<{ issue_id: string }>;

  return new Set(rows.map((r) => r.issue_id));
}

/**
 * Add item to outbox queue
 */
export function queueOutboxItem(
  operation: OutboxItem["operation"],
  payload: Record<string, unknown>
): number {
  const db = getDatabase();
  db.run(`
    INSERT INTO outbox (operation, payload)
    VALUES (?, ?)
  `, [operation, JSON.stringify(payload)]);

  // Get last insert rowid
  const result = db.query("SELECT last_insert_rowid() as id").get() as { id: number };
  return result.id;
}

/**
 * Get pending outbox items
 */
export function getPendingOutboxItems(): OutboxItem[] {
  const db = getDatabase();
  const rows = db.query("SELECT * FROM outbox ORDER BY id ASC").all() as Array<Record<string, unknown>>;

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
  db.run(`
    UPDATE outbox 
    SET retry_count = retry_count + 1, last_error = ?
    WHERE id = ?
  `, [error, id]);
}

/**
 * Clear all cached data
 */
export function clearCache(): void {
  const db = getDatabase();
  db.exec(`
    DELETE FROM issues;
    DELETE FROM dependencies;
    DELETE FROM labels;
    DELETE FROM metadata;
  `);
}

/**
 * Cache a label
 */
export function cacheLabel(id: string, name: string, teamId?: string): void {
  const db = getDatabase();
  db.run(`
    INSERT OR REPLACE INTO labels (id, name, team_id)
    VALUES (?, ?, ?)
  `, [id, name, teamId || null]);
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
