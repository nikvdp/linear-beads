/**
 * SQLite database for local cache and outbox queue
 * Uses bun:sqlite for Bun compatibility
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { ensureRepoMinCliVersion, getDbPath, getTeamKey } from "./config.js";
import { requestJsonlExport } from "./jsonl-scheduler.js";
import type {
  AgentIdentity,
  Dependency,
  Issue,
  MailMessage,
  MailRecipient,
  MailRecipientKind,
  MailThread,
  OutboxItem,
} from "../types.js";

let db: Database | null = null;
const LOCAL_ID_PREFIX = "LOCAL-";
const SQLITE_BUSY_TIMEOUT_MS = 10000;
const SQLITE_MAX_LOCK_RETRIES = 20;
const SQLITE_RETRY_BASE_DELAY_MS = 50;
const OUTBOX_CLAIM_TIMEOUT_MS = 600000;
const OUTBOX_RETRY_BASE_DELAY_MS = 1000;
const OUTBOX_RETRY_MAX_DELAY_MS = 300000;
const LOCAL_ID_WITH_DASH_RE = /^local-(\d+)$/i;
const LINEAR_ID_WITH_DASH_RE = /^([A-Za-z]+)-(\d+)$/;
const LINEAR_ID_NO_DASH_RE = /^([A-Za-z]+)(\d+)$/;
const NUMERIC_ISSUE_ID_RE = /^\d+$/;
const MAIL_RECIPIENT_KINDS: readonly MailRecipientKind[] = ["to", "cc", "bcc"];
const AGENT_ADJECTIVES = [
  "Amber",
  "Blue",
  "Cinder",
  "Crimson",
  "Emerald",
  "Golden",
  "Indigo",
  "Ivory",
  "Jade",
  "Nova",
  "Onyx",
  "Quartz",
  "Ruby",
  "Silver",
  "Solar",
  "Swift",
  "Violet",
  "Zen",
];
const AGENT_NOUNS = [
  "Aster",
  "Bridge",
  "Castle",
  "Comet",
  "Delta",
  "Falcon",
  "Forest",
  "Forge",
  "Harbor",
  "Lake",
  "Meadow",
  "River",
  "Summit",
  "Tower",
  "Vale",
  "Vertex",
  "Willow",
];
const HANDLE_SANITIZE_RE = /[^a-zA-Z0-9_-]/g;
const BREAKING_SCHEMA_V6_MIN_CLI = "v16";
const V6_BACKUP_METADATA_KEY = "migration_backup_v6";
const RELATED_DEPENDENCY_INTEGRITY_METADATA_KEY = "related_dependency_integrity_v1";
const DEPENDENCY_ALIAS_INTEGRITY_METADATA_KEY = "dependency_alias_integrity_v1";
const SCHEMA_INIT_LOCK_TTL_MS = 10 * 60 * 1000;
const SCHEMA_INIT_LOCK_POLL_MS = 50;
const SCHEMA_INIT_LOCK_WAIT_MS = 60 * 1000;
const LAST_SYNC_CONTEXT_METADATA_KEY = "last_sync_context";

function isDatabaseLockedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("database is locked") ||
    msg.includes("database table is locked") ||
    msg.includes("database schema is locked")
  );
}

function isDuplicateColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.toLowerCase().includes("duplicate column name");
}

function addColumnIfMissing(
  db: Database,
  tableName: string,
  columnName: string,
  alterStatement: string
): void {
  const existingColumns = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  if (existingColumns.some((column) => column.name === columnName)) {
    return;
  }

  try {
    db.exec(alterStatement);
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
    }
  }
}

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function getSchemaInitLockPath(dbPath: string): string {
  return join(dirname(dbPath), "cache.schema.lock");
}

function withSchemaInitLock<T>(dbPath: string, operation: () => T): T {
  const lockPath = getSchemaInitLockPath(dbPath);
  const deadline = Date.now() + SCHEMA_INIT_LOCK_WAIT_MS;

  while (true) {
    try {
      const stat = statSync(lockPath);
      if (Date.now() - stat.mtimeMs > SCHEMA_INIT_LOCK_TTL_MS) {
        unlinkSync(lockPath);
      }
    } catch {
      // No lock file yet.
    }

    let lockFd: number | null = null;
    try {
      lockFd = openSync(lockPath, "wx");
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for schema init lock at ${lockPath}. Another lb process may be stuck.`
        );
      }
      sleepSync(SCHEMA_INIT_LOCK_POLL_MS);
      continue;
    }

    try {
      return operation();
    } finally {
      if (lockFd !== null) {
        closeSync(lockFd);
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // Lock file may already be gone.
      }
    }
  }
}

export function runWithBusyRetry<T>(operation: () => T): T {
  let attempt = 0;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isDatabaseLockedError(error) || attempt >= SQLITE_MAX_LOCK_RETRIES) {
        throw error;
      }
      const backoffMs = SQLITE_RETRY_BASE_DELAY_MS * (attempt + 1);
      sleepSync(backoffMs);
      attempt++;
    }
  }
}

function canonicalizeDependencyPair(
  issueId: string,
  dependsOnId: string,
  type: Dependency["type"]
): [string, string] {
  if (type !== "related") {
    return [issueId, dependsOnId];
  }

  if (issueId <= dependsOnId) {
    return [issueId, dependsOnId];
  }

  return [dependsOnId, issueId];
}

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
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    withSchemaInitLock(dbPath, () => {
      runWithBusyRetry(() => {
        const journalModeRow = db!.query("PRAGMA journal_mode").get() as {
          journal_mode?: string;
        } | null;
        const journalMode = journalModeRow?.journal_mode?.toLowerCase();
        if (journalMode !== "wal") {
          db!.exec("PRAGMA journal_mode = WAL");
        }
        db!.exec("PRAGMA synchronous = NORMAL");
        initSchema(db!, dbPath);
      });
    });
  }
  return db;
}

/**
 * Initialize database schema
 */
function initSchema(db: Database, dbPath: string): void {
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
        sync_key TEXT,
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
          sync_key TEXT,
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
        INSERT INTO issues_new (
          id,
          identifier,
          sync_key,
          title,
          description,
          status,
          priority,
          issue_type,
          created_at,
          updated_at,
          closed_at,
          assignee,
          linear_state_id,
          cached_at,
          sync_status
        )
        SELECT
          id,
          identifier,
          NULL AS sync_key,
          title,
          description,
          status,
          priority,
          issue_type,
          created_at,
          updated_at,
          closed_at,
          assignee,
          linear_state_id,
          cached_at,
          'synced'
        FROM issues;
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

    -- Projects cache (for project-based repo scoping)
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      team_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);

    -- Outbox queue for pending mutations
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      payload TEXT NOT NULL,
      local_id TEXT,
      remote_issue_identifier TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      next_attempt_at TEXT,
      processing INTEGER NOT NULL DEFAULT 0,
      processing_started_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS issue_id_map (
      local_id TEXT PRIMARY KEY,
      linear_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_issue_id_map_linear_id ON issue_id_map(linear_id);

    -- Metadata (cache timestamps, etc.)
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  if (currentVersion < 2) {
    addColumnIfMissing(
      db,
      "issues",
      "sync_status",
      "ALTER TABLE issues ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'synced'"
    );
    addColumnIfMissing(db, "outbox", "local_id", "ALTER TABLE outbox ADD COLUMN local_id TEXT");

    db.exec(`
      CREATE TABLE IF NOT EXISTS issue_id_map (
        local_id TEXT PRIMARY KEY,
        linear_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    db.exec("PRAGMA user_version = 2");
  }

  if (currentVersion < 3) {
    addColumnIfMissing(
      db,
      "outbox",
      "processing",
      "ALTER TABLE outbox ADD COLUMN processing INTEGER NOT NULL DEFAULT 0"
    );
    addColumnIfMissing(
      db,
      "outbox",
      "processing_started_at",
      "ALTER TABLE outbox ADD COLUMN processing_started_at TEXT"
    );

    db.exec("PRAGMA user_version = 3");
  }

  if (currentVersion < 4) {
    addColumnIfMissing(
      db,
      "outbox",
      "next_attempt_at",
      "ALTER TABLE outbox ADD COLUMN next_attempt_at TEXT"
    );

    db.exec("PRAGMA user_version = 4");
  }

  if (currentVersion < 5) {
    db.exec(`
      -- Agent identity registry (local-first)
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE,
        display_name TEXT,
        pubkey TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agents_handle ON agents(handle);

      -- Mail thread registry
      CREATE TABLE IF NOT EXISTS mail_threads (
        id TEXT PRIMARY KEY,
        work_item_ref TEXT,
        subject TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mail_threads_work_item_ref ON mail_threads(work_item_ref);

      -- Mail messages (canonical local log)
      CREATE TABLE IF NOT EXISTS mail_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        sender_agent_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_md TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reply_to_message_id TEXT,
        sync_status TEXT NOT NULL DEFAULT 'synced'
      );
      CREATE INDEX IF NOT EXISTS idx_mail_messages_thread_created_at
        ON mail_messages(thread_id, created_at);

      -- Per-recipient mailbox/read/ack state
      CREATE TABLE IF NOT EXISTS mail_recipients (
        message_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        delivered_at TEXT,
        read_at TEXT,
        ack_at TEXT,
        UNIQUE(message_id, recipient_agent_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_mail_recipients_inbox
        ON mail_recipients(recipient_agent_id, read_at, delivered_at);
      CREATE INDEX IF NOT EXISTS idx_mail_recipients_message_id ON mail_recipients(message_id);

      -- Optional separate outbox for future adapter-specific mail sync pipelines
      CREATE TABLE IF NOT EXISTS mail_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        next_attempt_at TEXT,
        processing INTEGER NOT NULL DEFAULT 0,
        processing_started_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );

      -- Mail adapter sync cursor/checkpoint state
      CREATE TABLE IF NOT EXISTS mail_sync_state (
        backend TEXT PRIMARY KEY,
        cursor TEXT,
        updated_at TEXT NOT NULL
      );
    `);

    db.exec("PRAGMA user_version = 5");
  }

  if (currentVersion < 6) {
    ensurePreMigrationBackup(db, dbPath, 6);

    const issueCols = db.query("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
    const hasLocalIdSchema = issueCols.some((c) => c.name === "local_id");

    if (!hasLocalIdSchema) {
      db.exec(`
        CREATE TABLE issues_new (
          local_id TEXT PRIMARY KEY,
          linear_id TEXT,
          linear_identifier TEXT,
          sync_key TEXT,
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

        INSERT INTO issues_new (
          local_id,
          linear_id,
          linear_identifier,
          sync_key,
          title,
          description,
          status,
          priority,
          issue_type,
          sync_status,
          created_at,
          updated_at,
          closed_at,
          assignee,
          linear_state_id,
          cached_at
        )
        SELECT
          id AS local_id,
          NULL AS linear_id,
          CASE
            WHEN UPPER(id) LIKE 'LOCAL-%' THEN NULL
            ELSE identifier
          END AS linear_identifier,
          NULL AS sync_key,
          title,
          description,
          status,
          priority,
          issue_type,
          sync_status,
          created_at,
          updated_at,
          closed_at,
          assignee,
          linear_state_id,
          cached_at
        FROM issues;

        DROP TABLE issues;
        ALTER TABLE issues_new RENAME TO issues;
      `);
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_linear_id ON issues(linear_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_linear_identifier ON issues(linear_identifier);
      CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
      CREATE INDEX IF NOT EXISTS idx_issues_sync_status ON issues(sync_status);
      CREATE INDEX IF NOT EXISTS idx_issues_cached_at ON issues(cached_at);
    `);

    db.exec("PRAGMA user_version = 6");
    ensureRepoMinCliVersion(BREAKING_SCHEMA_V6_MIN_CLI);
  }

  if (currentVersion < 7) {
    addColumnIfMissing(
      db,
      "outbox",
      "remote_issue_identifier",
      "ALTER TABLE outbox ADD COLUMN remote_issue_identifier TEXT"
    );

    db.exec("PRAGMA user_version = 7");
  }

  if (currentVersion < 8) {
    addColumnIfMissing(db, "issues", "sync_key", "ALTER TABLE issues ADD COLUMN sync_key TEXT");
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_sync_key
      ON issues(sync_key)
      WHERE sync_key IS NOT NULL;
    `);
    db.exec("PRAGMA user_version = 8");
  }

  ensureDependencyAliasIntegrity(db);
  ensureRelatedDependencyIntegrity(db);
}

function ensureDependencyAliasIntegrity(db: Database): void {
  const existing = db
    .query("SELECT value FROM metadata WHERE key = ?")
    .get(DEPENDENCY_ALIAS_INTEGRITY_METADATA_KEY) as { value?: string } | null;
  if (existing?.value) {
    return;
  }

  // Normalize dependencies that reference synced issue aliases (LIN-*) back to canonical local_id.
  db.exec(`
    INSERT OR IGNORE INTO dependencies (issue_id, depends_on_id, type, created_at, created_by)
    SELECT i.local_id, d.depends_on_id, d.type, d.created_at, d.created_by
    FROM dependencies d
    JOIN issues i ON i.linear_identifier = d.issue_id
    WHERE i.linear_identifier IS NOT NULL
      AND i.local_id != d.issue_id;
  `);

  db.exec(`
    DELETE FROM dependencies
    WHERE issue_id IN (
      SELECT linear_identifier
      FROM issues
      WHERE linear_identifier IS NOT NULL
    );
  `);

  db.exec(`
    INSERT OR IGNORE INTO dependencies (issue_id, depends_on_id, type, created_at, created_by)
    SELECT d.issue_id, i.local_id, d.type, d.created_at, d.created_by
    FROM dependencies d
    JOIN issues i ON i.linear_identifier = d.depends_on_id
    WHERE i.linear_identifier IS NOT NULL
      AND i.local_id != d.depends_on_id;
  `);

  db.exec(`
    DELETE FROM dependencies
    WHERE depends_on_id IN (
      SELECT linear_identifier
      FROM issues
      WHERE linear_identifier IS NOT NULL
    );
  `);

  db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", [
    DEPENDENCY_ALIAS_INTEGRITY_METADATA_KEY,
    new Date().toISOString(),
  ]);
}

function ensureRelatedDependencyIntegrity(db: Database): void {
  const existing = db
    .query("SELECT value FROM metadata WHERE key = ?")
    .get(RELATED_DEPENDENCY_INTEGRITY_METADATA_KEY) as { value?: string } | null;
  if (existing?.value) {
    return;
  }

  db.exec(`
    DELETE FROM dependencies
    WHERE type = 'related'
      AND id NOT IN (
        SELECT MIN(id)
        FROM dependencies
        WHERE type = 'related'
        GROUP BY
          CASE WHEN issue_id <= depends_on_id THEN issue_id ELSE depends_on_id END,
          CASE WHEN issue_id <= depends_on_id THEN depends_on_id ELSE issue_id END
      );
  `);

  db.exec(`
    UPDATE dependencies
    SET issue_id = CASE WHEN issue_id <= depends_on_id THEN issue_id ELSE depends_on_id END,
        depends_on_id = CASE WHEN issue_id <= depends_on_id THEN depends_on_id ELSE issue_id END
    WHERE type = 'related'
      AND issue_id > depends_on_id;
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_deps_related_canonical_unique
    ON dependencies (
      CASE WHEN issue_id <= depends_on_id THEN issue_id ELSE depends_on_id END,
      CASE WHEN issue_id <= depends_on_id THEN depends_on_id ELSE issue_id END
    )
    WHERE type = 'related';
  `);

  db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", [
    RELATED_DEPENDENCY_INTEGRITY_METADATA_KEY,
    new Date().toISOString(),
  ]);
}

function ensurePreMigrationBackup(db: Database, dbPath: string, targetVersion: number): void {
  const metadataKey =
    targetVersion === 6 ? V6_BACKUP_METADATA_KEY : `migration_backup_v${targetVersion}`;
  const existing = db.query("SELECT value FROM metadata WHERE key = ?").get(metadataKey) as {
    value: string;
  } | null;
  if (existing?.value && existsSync(existing.value)) {
    return;
  }

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

  const backupDir = `${dirname(dbPath)}/backups`;
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${backupDir}/cache-pre-v${targetVersion}-${timestamp}.db`;
  copyFileSync(dbPath, backupPath);

  db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", [metadataKey, backupPath]);
}

/**
 * Generate next local issue ID (LOCAL-001, LOCAL-002, etc.)
 */
export function generateLocalId(): string {
  const db = getDatabase();

  // Increment counter atomically to avoid duplicate LOCAL IDs under parallel writes.
  const row = runWithBusyRetry(
    () =>
      db
        .query(
          `
        INSERT INTO metadata (key, value)
        VALUES ('local_id_counter', '1')
        ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
        RETURNING value
      `
        )
        .get() as { value: string }
  );
  const nextNum = parseInt(row.value, 10);

  return `LOCAL-${nextNum.toString().padStart(3, "0")}`;
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
 * Get last sync context fingerprint (team/scope/repo).
 */
export function getLastSyncContext(): string | null {
  const db = getDatabase();
  const row = db.query("SELECT value FROM metadata WHERE key = ?").get(
    LAST_SYNC_CONTEXT_METADATA_KEY
  ) as {
    value: string;
  } | null;
  return row?.value || null;
}

/**
 * Update sync context fingerprint after a successful sync.
 */
export function updateLastSyncContext(contextKey: string): void {
  const db = getDatabase();
  runWithBusyRetry(() => {
    db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", [
      LAST_SYNC_CONTEXT_METADATA_KEY,
      contextKey,
    ]);
  });
}

/**
 * Returns true when current sync context differs from the most recent sync.
 */
export function hasSyncContextChanged(contextKey: string): boolean {
  const lastContext = getLastSyncContext();
  return !lastContext || lastContext !== contextKey;
}

/**
 * Cache is stale if TTL expired or if sync context changed (team/scope/repo).
 */
export function isCacheStaleForContext(contextKey: string, ttlSeconds: number = 120): boolean {
  if (isCacheStale(ttlSeconds)) {
    return true;
  }

  return hasSyncContextChanged(contextKey);
}

/**
 * Get last sync time and cache age info
 */
export function getCacheInfo(): { lastSync: Date | null; ageSeconds: number; isStale: boolean } {
  const db = getDatabase();
  const row = db.query("SELECT value FROM metadata WHERE key = 'last_sync'").get() as {
    value: string;
  } | null;

  if (!row) {
    return { lastSync: null, ageSeconds: Infinity, isStale: true };
  }

  const lastSync = new Date(row.value);
  const now = new Date();
  const ageSeconds = (now.getTime() - lastSync.getTime()) / 1000;

  return { lastSync, ageSeconds, isStale: ageSeconds > 120 };
}

/**
 * Update last sync timestamp
 */
export function updateLastSync(): void {
  const db = getDatabase();
  // Store as ISO string with Z suffix so parsing knows it's UTC
  runWithBusyRetry(() => {
    db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync', ?)", [
      new Date().toISOString(),
    ]);
  });
  requestJsonlExport();
}

/**
 * Get the last sync timestamp as ISO string (or null if never synced)
 */
export function getLastSync(): string | null {
  const db = getDatabase();
  const row = db.query("SELECT value FROM metadata WHERE key = 'last_sync'").get() as {
    value: string;
  } | null;
  return row?.value || null;
}

/**
 * Get timestamp for incremental sync with 5-minute lookback.
 * Returns ISO string of (last_sync - 5 minutes) or null if never synced.
 * The lookback prevents missing issues updated during the previous sync.
 */
export function getIncrementalSyncTimestamp(): string | null {
  const lastSync = getLastSync();
  if (!lastSync) return null;

  const lastSyncDate = new Date(lastSync);
  const lookbackMs = 5 * 60 * 1000; // 5 minutes
  const lookbackDate = new Date(lastSyncDate.getTime() - lookbackMs);
  return lookbackDate.toISOString();
}

/**
 * Get the sync run count (how many times lb sync has been called)
 */
export function getSyncRunCount(): number {
  const db = getDatabase();
  const row = db.query("SELECT value FROM metadata WHERE key = 'sync_run_count'").get() as {
    value: string;
  } | null;
  return row ? parseInt(row.value, 10) : 0;
}

/**
 * Increment sync run count (called after each sync)
 */
export function incrementSyncRunCount(): number {
  const db = getDatabase();
  const current = getSyncRunCount();
  const next = current + 1;
  runWithBusyRetry(() => {
    db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('sync_run_count', ?)", [
      next.toString(),
    ]);
  });
  return next;
}

/**
 * Get last full sync timestamp as ISO string (or null if never done)
 */
export function getLastFullSync(): string | null {
  const db = getDatabase();
  const row = db.query("SELECT value FROM metadata WHERE key = 'last_full_sync'").get() as {
    value: string;
  } | null;
  return row?.value || null;
}

/**
 * Update last full sync timestamp to now
 */
export function updateLastFullSync(): void {
  const db = getDatabase();
  runWithBusyRetry(() => {
    db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_full_sync', ?)", [
      new Date().toISOString(),
    ]);
  });
}

/**
 * Check if a full sync is needed based on run count or time.
 * Full sync every 3rd run OR if last full sync was >24 hours ago.
 */
export function needsFullSync(): boolean {
  const runCount = getSyncRunCount();
  const lastFullSync = getLastFullSync();

  // Every 3rd run
  if (runCount > 0 && runCount % 3 === 0) {
    return true;
  }

  // If never done a full sync, we need one
  if (!lastFullSync) {
    return true;
  }

  // If last full sync was more than 24 hours ago
  const lastFullSyncDate = new Date(lastFullSync);
  const now = new Date();
  const hoursSinceFullSync = (now.getTime() - lastFullSyncDate.getTime()) / (1000 * 60 * 60);
  return hoursSinceFullSync > 24;
}

/**
 * Cache an issue
 */
type CachedIssueInput = Issue & {
  linear_state_id?: string;
  sync_status?: "synced" | "pending" | "failed";
  local_id?: string;
  linear_id?: string;
  linear_identifier?: string;
  sync_key?: string;
};

function toIssueDisplayId(localId: string, linearIdentifier?: string | null): string {
  return linearIdentifier || localId;
}

function findExistingLocalIdForIssue(
  db: Database,
  localId: string,
  linearId?: string,
  linearIdentifier?: string,
  syncKey?: string
): string | null {
  const row = db
    .query(
      `
      SELECT local_id
      FROM issues
      WHERE local_id = ?
         OR (? IS NOT NULL AND linear_id = ?)
         OR (? IS NOT NULL AND linear_identifier = ?)
         OR (? IS NOT NULL AND sync_key = ?)
      LIMIT 1
    `
    )
    .get(
      localId,
      linearId || null,
      linearId || null,
      linearIdentifier || null,
      linearIdentifier || null,
      syncKey || null,
      syncKey || null
    ) as { local_id: string } | null;

  return row?.local_id || null;
}

function upsertIssueRow(db: Database, issue: CachedIssueInput): void {
  const normalizedSyncStatus = issue.sync_status || "synced";
  const providedLocalId = issue.local_id || issue.id;
  const inferredLinearIdentifier =
    issue.linear_identifier || (!isLocalId(issue.id) ? issue.id : undefined);
  const existingLocalId = findExistingLocalIdForIssue(
    db,
    providedLocalId,
    issue.linear_id,
    inferredLinearIdentifier,
    issue.sync_key
  );
  const localId = existingLocalId || providedLocalId;
  const linearIdentifier = inferredLinearIdentifier || (isLocalId(localId) ? null : localId);

  db.run(
    `
      INSERT INTO issues (
        local_id,
        linear_id,
        linear_identifier,
        sync_key,
        title,
        description,
        status,
        priority,
        issue_type,
        sync_status,
        created_at,
        updated_at,
        closed_at,
        assignee,
        linear_state_id,
        cached_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(local_id) DO UPDATE SET
        linear_id = COALESCE(excluded.linear_id, issues.linear_id),
        linear_identifier = COALESCE(excluded.linear_identifier, issues.linear_identifier),
        sync_key = COALESCE(excluded.sync_key, issues.sync_key),
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        priority = excluded.priority,
        issue_type = excluded.issue_type,
        sync_status = excluded.sync_status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        closed_at = excluded.closed_at,
        assignee = excluded.assignee,
        linear_state_id = excluded.linear_state_id,
        cached_at = datetime('now')
    `,
    [
      localId,
      issue.linear_id || null,
      linearIdentifier,
      issue.sync_key || null,
      issue.title,
      issue.description || null,
      issue.status,
      issue.priority,
      issue.issue_type || null,
      normalizedSyncStatus,
      issue.created_at,
      issue.updated_at,
      issue.closed_at || null,
      issue.assignee || null,
      issue.linear_state_id || null,
    ]
  );
}

function rowToIssue(row: Record<string, unknown>): Issue {
  const localId = row.local_id as string;
  const linearIdentifier = row.linear_identifier as string | null;

  const issue: Issue = {
    id: toIssueDisplayId(localId, linearIdentifier),
    local_id: localId,
    linear_id: (row.linear_id as string | null) || undefined,
    linear_identifier: linearIdentifier || undefined,
    title: row.title as string,
    description: row.description as string | undefined,
    status: row.status as Issue["status"],
    priority: row.priority as Issue["priority"],
    sync_status: (row.sync_status as Issue["sync_status"]) || "synced",
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

export function cacheIssue(issue: CachedIssueInput): void {
  const db = getDatabase();
  runWithBusyRetry(() => {
    upsertIssueRow(db, issue);
  });
  requestJsonlExport();
}

/**
 * Cache multiple issues (transactional)
 */
export function cacheIssues(issues: Array<Issue & { linear_state_id?: string }>): void {
  const db = getDatabase();
  const transaction = db.transaction(() => {
    for (const issue of issues) {
      upsertIssueRow(db, issue);
    }
  });

  runWithBusyRetry(() => {
    transaction();
  });
  requestJsonlExport();
}

/**
 * Get cached issue by ID
 */
export function getCachedIssue(id: string): Issue | null {
  const db = getDatabase();
  const normalizedId = normalizeIssueInputId(id);
  const resolvedLocalId = resolveIssueLocalId(normalizedId);
  const row = db
    .query("SELECT * FROM issues WHERE local_id = ? OR linear_identifier = ? LIMIT 1")
    .get(resolvedLocalId, normalizedId) as Record<string, unknown> | null;

  if (!row) return null;
  return rowToIssue(row);
}

/**
 * Get all cached issues
 */
export function getCachedIssues(): Issue[] {
  const db = getDatabase();
  const rows = db.query("SELECT * FROM issues ORDER BY updated_at DESC").all() as Array<
    Record<string, unknown>
  >;

  return rows.map((row) => rowToIssue(row));
}

/**
 * Cache a dependency
 */
export function cacheDependency(dep: Dependency): void {
  const db = getDatabase();
  const resolvedIssueId = resolveIssueLocalId(dep.issue_id);
  const resolvedDependsOnId = resolveIssueLocalId(dep.depends_on_id);
  const [issueId, dependsOnId] = canonicalizeDependencyPair(
    resolvedIssueId,
    resolvedDependsOnId,
    dep.type
  );
  runWithBusyRetry(() => {
    db.run(
      `
    INSERT OR REPLACE INTO dependencies 
    (issue_id, depends_on_id, type, created_at, created_by)
    VALUES (?, ?, ?, ?, ?)
  `,
      [issueId, dependsOnId, dep.type, dep.created_at, dep.created_by]
    );
  });
  requestJsonlExport();
}

/**
 * Clear all dependencies for an issue (before re-syncing)
 */
export function clearIssueDependencies(issueId: string): void {
  const db = getDatabase();
  const resolvedId = resolveIssueLocalId(issueId);
  runWithBusyRetry(() => {
    db.run("DELETE FROM dependencies WHERE issue_id = ?", [resolvedId]);
  });
  requestJsonlExport();
}

/**
 * Delete a specific dependency between two issues
 */
export function deleteDependency(issueId: string, dependsOnId: string): void {
  const db = getDatabase();
  const resolvedIssueId = resolveIssueLocalId(issueId);
  const resolvedDependsOnId = resolveIssueLocalId(dependsOnId);
  runWithBusyRetry(() => {
    db.run("DELETE FROM dependencies WHERE issue_id = ? AND depends_on_id = ?", [
      resolvedIssueId,
      resolvedDependsOnId,
    ]);
    // Also try the reverse direction
    db.run("DELETE FROM dependencies WHERE issue_id = ? AND depends_on_id = ?", [
      resolvedDependsOnId,
      resolvedIssueId,
    ]);
  });
  requestJsonlExport();
}

/**
 * Delete a dependency for a specific type/direction.
 */
export function deleteDependencyByType(
  issueId: string,
  dependsOnId: string,
  type: Dependency["type"]
): void {
  const db = getDatabase();
  const resolvedIssueId = resolveIssueLocalId(issueId);
  const resolvedDependsOnId = resolveIssueLocalId(dependsOnId);
  const [leftId, rightId] = canonicalizeDependencyPair(resolvedIssueId, resolvedDependsOnId, type);

  runWithBusyRetry(() => {
    db.run("DELETE FROM dependencies WHERE issue_id = ? AND depends_on_id = ? AND type = ?", [
      leftId,
      rightId,
      type,
    ]);
  });
  requestJsonlExport();
}

/**
 * Delete a related relationship pair in both directions.
 * Removes all rows for legacy duplicate states.
 */
export function deleteRelatedDependency(issueId: string, relatedIssueId: string): void {
  const db = getDatabase();
  const resolvedIssueId = resolveIssueLocalId(issueId);
  const resolvedRelatedId = resolveIssueLocalId(relatedIssueId);
  const [leftId, rightId] = canonicalizeDependencyPair(
    resolvedIssueId,
    resolvedRelatedId,
    "related"
  );

  runWithBusyRetry(() => {
    db.run(
      `
      DELETE FROM dependencies
      WHERE type = 'related'
        AND (
          (issue_id = ? AND depends_on_id = ?)
          OR
          (issue_id = ? AND depends_on_id = ?)
        )
    `,
      [leftId, rightId, rightId, leftId]
    );
  });
  requestJsonlExport();
}

/**
 * Get dependencies for an issue (outgoing: this issue depends on others)
 */
export function getDependencies(issueId: string): Dependency[] {
  const db = getDatabase();
  const resolvedId = resolveIssueLocalId(issueId);
  const rows = db.query("SELECT * FROM dependencies WHERE issue_id = ?").all(resolvedId) as Array<
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
 * Get parent issue ID (if any)
 */
export function getParentId(issueId: string): string | null {
  const deps = getDependencies(issueId);
  const parentDep = deps.find((d) => d.type === "parent-child");
  return parentDep?.depends_on_id || null;
}

/**
 * Get child issue IDs
 */
export function getChildIds(issueId: string): string[] {
  const db = getDatabase();
  const resolvedId = resolveIssueLocalId(issueId);
  const rows = db
    .query("SELECT issue_id FROM dependencies WHERE depends_on_id = ? AND type = 'parent-child'")
    .all(resolvedId) as Array<{ issue_id: string }>;
  return rows.map((r) => r.issue_id);
}

/**
 * Get inverse dependencies for an issue (incoming: others depend on this issue)
 */
export function getInverseDependencies(issueId: string): Dependency[] {
  const db = getDatabase();
  const resolvedId = resolveIssueLocalId(issueId);
  const rows = db
    .query("SELECT * FROM dependencies WHERE depends_on_id = ?")
    .all(resolvedId) as Array<Record<string, unknown>>;

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
  const resolvedId = resolveIssueLocalId(issueId);
  const rows = db
    .query("SELECT * FROM dependencies WHERE depends_on_id = ?")
    .all(resolvedId) as Array<Record<string, unknown>>;

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
    JOIN issues i ON d.issue_id = i.local_id
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
  payload: Record<string, unknown>,
  localId?: string
): number {
  const db = getDatabase();
  runWithBusyRetry(() => {
    db.run(
      `
    INSERT INTO outbox (operation, payload, local_id)
    VALUES (?, ?, ?)
  `,
      [operation, JSON.stringify(payload), localId || null]
    );
  });

  // Get last insert rowid
  const result = db.query("SELECT last_insert_rowid() as id").get() as { id: number };
  return result.id;
}

export function generateIssueSyncKey(): string {
  return randomUUID();
}

export function getIssueSyncKey(localId: string): string | null {
  const db = getDatabase();
  const resolvedLocalId = resolveIssueLocalId(localId);
  const row = db.query("SELECT sync_key FROM issues WHERE local_id = ?").get(resolvedLocalId) as {
    sync_key: string | null;
  } | null;
  return row?.sync_key || null;
}

export function ensureIssueSyncKey(localId: string): string {
  const db = getDatabase();
  const resolvedLocalId = resolveIssueLocalId(localId);
  const existing = getIssueSyncKey(resolvedLocalId);
  if (existing) {
    return existing;
  }

  const syncKey = generateIssueSyncKey();
  runWithBusyRetry(() => {
    db.run("UPDATE issues SET sync_key = ? WHERE local_id = ?", [syncKey, resolvedLocalId]);
  });
  return syncKey;
}

export function getSyncedIssueBySyncKey(syncKey: string): {
  local_id: string;
  linear_id: string | null;
  linear_identifier: string;
} | null {
  const db = getDatabase();
  const row = db
    .query(
      `
      SELECT local_id, linear_id, linear_identifier
      FROM issues
      WHERE sync_key = ?
        AND linear_identifier IS NOT NULL
      LIMIT 1
    `
    )
    .get(syncKey) as { local_id: string; linear_id: string | null; linear_identifier: string } | null;
  return row;
}

type RebuildableIssueRow = {
  local_id: string;
  title: string;
  description: string | null;
  priority: number;
  issue_type: string | null;
  sync_key: string | null;
  sync_status: "synced" | "pending" | "failed" | null;
};

function buildCreatePayloadForIssue(db: Database, row: RebuildableIssueRow): Record<string, unknown> {
  const parent = db
    .query(
      `
      SELECT depends_on_id
      FROM dependencies
      WHERE issue_id = ? AND type = 'parent-child'
      LIMIT 1
    `
    )
    .get(row.local_id) as { depends_on_id: string } | null;

  const outgoingDeps = db
    .query(
      `
      SELECT type, depends_on_id
      FROM dependencies
      WHERE issue_id = ?
        AND type IN ('blocks', 'related')
      ORDER BY id ASC
    `
    )
    .all(row.local_id) as Array<{ type: "blocks" | "related"; depends_on_id: string }>;

  const blockedBy = db
    .query(
      `
      SELECT issue_id
      FROM dependencies
      WHERE depends_on_id = ?
        AND type = 'blocks'
      ORDER BY id ASC
    `
    )
    .all(row.local_id) as Array<{ issue_id: string }>;

  const deps = [
    ...outgoingDeps.map((dep) => `${dep.type}:${dep.depends_on_id}`),
    ...blockedBy.map((dep) => `blocked-by:${dep.issue_id}`),
  ];
  const dedupedDeps = [...new Set(deps)];
  const syncKey = row.sync_key || generateIssueSyncKey();

  return {
    title: row.title,
    description: row.description || undefined,
    priority: row.priority,
    issueType: row.issue_type || undefined,
    parentId: parent?.depends_on_id || undefined,
    deps: dedupedDeps.length > 0 ? dedupedDeps.join(",") : undefined,
    syncKey,
  };
}

type RepairCreateOutboxResult = {
  queued: number;
  revived: number;
};

/**
 * Repair create outbox rows for unresolved local issues.
 * - Queues missing create rows
 * - Revives existing create rows that are backoff-delayed or left in processing state
 */
export function repairCreateOutboxForUnsyncedIssues(limit: number = 200): RepairCreateOutboxResult {
  const db = getDatabase();
  const nowIso = new Date().toISOString();
  const candidates = db
    .query(
      `
      SELECT local_id, title, description, priority, issue_type, sync_key, sync_status
      FROM issues i
      WHERE (i.linear_identifier IS NULL OR trim(i.linear_identifier) = '')
        AND (
          i.local_id LIKE 'LOCAL-%'
          OR i.sync_status IN ('pending', 'failed')
        )
      ORDER BY i.created_at ASC
      LIMIT ?
    `
    )
    .all(limit) as RebuildableIssueRow[];

  if (candidates.length === 0) {
    return { queued: 0, revived: 0 };
  }

  let queued = 0;
  let revived = 0;
  runWithBusyRetry(() => {
    for (const row of candidates) {
      const existingCreate = db
        .query(
          `
          SELECT id, next_attempt_at, processing
          FROM outbox
          WHERE operation = 'create'
            AND local_id = ?
          ORDER BY id ASC
        `
        )
        .all(row.local_id) as Array<{
        id: number;
        next_attempt_at: string | null;
        processing: number;
      }>;

      let syncKey: string;
      if (existingCreate.length === 0) {
        const payload = buildCreatePayloadForIssue(db, row);
        syncKey = typeof payload.syncKey === "string" ? payload.syncKey : generateIssueSyncKey();
        db.run(
          `
          INSERT INTO outbox (operation, payload, local_id)
          VALUES ('create', ?, ?)
        `,
          [JSON.stringify(payload), row.local_id]
        );
        queued++;
      } else {
        syncKey = row.sync_key || generateIssueSyncKey();
        db.run(
          `
          UPDATE outbox
          SET next_attempt_at = NULL,
              processing = 0,
              processing_started_at = NULL
          WHERE operation = 'create'
            AND local_id = ?
            AND (
              processing = 1
              OR next_attempt_at IS NOT NULL
            )
        `,
          [row.local_id]
        );
        const reviveChanges = db.query("SELECT changes() as count").get() as { count: number };
        revived += reviveChanges.count;
      }

      db.run(
        `
        UPDATE issues
        SET sync_status = CASE
              WHEN sync_status IN ('pending', 'failed') THEN sync_status
              WHEN sync_status = 'synced' OR sync_status IS NULL THEN 'pending'
              ELSE sync_status
            END,
            sync_key = COALESCE(sync_key, ?),
            updated_at = ?
        WHERE local_id = ?
      `,
        [syncKey, nowIso, row.local_id]
      );
    }
  });

  requestJsonlExport();
  return { queued, revived };
}

/**
 * Backwards-compatible helper retained for tests/callers expecting a queued count.
 */
export function queueMissingCreateOutboxItems(limit: number = 200): number {
  return repairCreateOutboxForUnsyncedIssues(limit).queued;
}

/**
 * Get pending outbox items
 */
export function getPendingOutboxItems(): OutboxItem[] {
  const db = getDatabase();
  const nowIso = new Date().toISOString();
  const rows = db
    .query(
      `
      SELECT * FROM outbox
      WHERE next_attempt_at IS NULL OR next_attempt_at <= ?
      ORDER BY id ASC
    `
    )
    .all(nowIso) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id as number,
    operation: row.operation as OutboxItem["operation"],
    payload: JSON.parse(row.payload as string),
    local_id: (row.local_id as string | null) || undefined,
    remote_issue_identifier: (row.remote_issue_identifier as string | null) || undefined,
    created_at: row.created_at as string,
    retry_count: row.retry_count as number,
    last_error: row.last_error as string | undefined,
  }));
}

export function markOutboxCreateRemoteIssueIdentifier(
  id: number,
  remoteIssueIdentifier: string
): void {
  const db = getDatabase();
  runWithBusyRetry(() => {
    db.run(
      `
      UPDATE outbox
      SET remote_issue_identifier = ?
      WHERE id = ? AND operation = 'create'
    `,
      [remoteIssueIdentifier, id]
    );
  });
}

/**
 * Get current outbox queue stats, including number of claimed in-flight items.
 */
export function getOutboxStats(): { total: number; processing: number } {
  const db = getDatabase();
  const totalRow = db.query("SELECT COUNT(*) as count FROM outbox").get() as { count: number };
  const processingRow = db
    .query("SELECT COUNT(*) as count FROM outbox WHERE processing = 1")
    .get() as { count: number };

  return {
    total: totalRow.count,
    processing: processingRow.count,
  };
}

/**
 * Remove item from outbox (after successful sync)
 */
export function removeOutboxItem(id: number): void {
  const db = getDatabase();
  runWithBusyRetry(() => {
    db.run("DELETE FROM outbox WHERE id = ?", [id]);
  });
}

/**
 * Attempt to claim an outbox item for processing.
 * Returns true if claimed, false if another worker already holds the claim.
 */
export function claimOutboxItem(id: number): boolean {
  const db = getDatabase();
  const nowIso = new Date().toISOString();
  const staleBeforeIso = new Date(Date.now() - OUTBOX_CLAIM_TIMEOUT_MS).toISOString();

  return runWithBusyRetry(() => {
    db.run(
      `
      UPDATE outbox
      SET processing = 1,
          processing_started_at = ?,
          next_attempt_at = NULL
      WHERE id = ?
        AND (
          processing = 0
          OR processing_started_at IS NULL
          OR processing_started_at < ?
        )
    `,
      [nowIso, id, staleBeforeIso]
    );

    const result = db.query("SELECT changes() as count").get() as { count: number };
    return result.count > 0;
  });
}

/**
 * Release processing claim without recording an error.
 */
export function releaseOutboxItemClaim(id: number): void {
  const db = getDatabase();
  runWithBusyRetry(() => {
    db.run(
      `
      UPDATE outbox
      SET processing = 0, processing_started_at = NULL
      WHERE id = ?
    `,
      [id]
    );
  });
}

/**
 * Update outbox item with error
 */
export function updateOutboxItemError(id: number, error: string): void {
  const db = getDatabase();
  const row = runWithBusyRetry(
    () =>
      db.query("SELECT retry_count FROM outbox WHERE id = ?").get(id) as {
        retry_count: number;
      } | null
  );

  if (!row) {
    return;
  }

  const nextRetryCount = row.retry_count + 1;
  const retryAfterSecondsMatch = error.match(/retry-?after"?\s*[:=]\s*"?(\d{1,6})/i);
  const retryAfterSeconds = retryAfterSecondsMatch ? parseInt(retryAfterSecondsMatch[1], 10) : null;
  const isRateLimited = error.toLowerCase().includes("rate limit");
  const backoffMs = retryAfterSeconds
    ? Math.min(retryAfterSeconds * 1000, OUTBOX_RETRY_MAX_DELAY_MS)
    : isRateLimited
      ? 60000
      : Math.min(
          OUTBOX_RETRY_BASE_DELAY_MS * 2 ** Math.min(nextRetryCount - 1, 8),
          OUTBOX_RETRY_MAX_DELAY_MS
        );
  const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();

  runWithBusyRetry(() => {
    db.run(
      `
    UPDATE outbox 
    SET retry_count = ?,
        last_error = ?,
        next_attempt_at = ?,
        processing = 0,
        processing_started_at = NULL
    WHERE id = ?
  `,
      [nextRetryCount, error, nextAttemptAt, id]
    );
  });
}

/**
 * Clear cached data for sync refresh
 * Preserves blocks/related dependencies (only cleared by individual --sync)
 */
export function clearCache(): void {
  const db = getDatabase();
  runWithBusyRetry(() => {
    db.exec(`
    DELETE FROM issues;
    DELETE FROM dependencies WHERE type = 'parent-child';
    DELETE FROM labels;
    DELETE FROM projects;
    DELETE FROM metadata;
  `);
  });
  requestJsonlExport();
}

/**
 * Clear issues cache (before full sync to remove stale issues from other repos)
 */
export function clearIssuesCache(): void {
  const db = getDatabase();
  runWithBusyRetry(() => {
    db.exec(`
    DELETE FROM issues;
    DELETE FROM dependencies WHERE type = 'parent-child';
  `);
  });
  requestJsonlExport();
}

/**
 * Delete a single issue from cache
 */
export function deleteCachedIssue(issueId: string): void {
  const db = getDatabase();
  const resolvedId = resolveIssueLocalId(issueId);
  runWithBusyRetry(() => {
    db.run("DELETE FROM issues WHERE local_id = ?", [resolvedId]);
    db.run("DELETE FROM dependencies WHERE issue_id = ? OR depends_on_id = ?", [
      resolvedId,
      resolvedId,
    ]);
  });
  requestJsonlExport();
}

/**
 * Cache a label
 */
export function cacheLabel(id: string, name: string, teamId?: string): void {
  const db = getDatabase();
  runWithBusyRetry(() => {
    db.run(
      `
    INSERT OR REPLACE INTO labels (id, name, team_id)
    VALUES (?, ?, ?)
  `,
      [id, name, teamId || null]
    );
  });
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
 * Cache a project
 */
export function cacheProject(id: string, name: string, teamId?: string): void {
  const db = getDatabase();
  runWithBusyRetry(() => {
    db.run(
      `
    INSERT OR REPLACE INTO projects (id, name, team_id)
    VALUES (?, ?, ?)
  `,
      [id, name, teamId || null]
    );
  });
}

/**
 * Get project ID by name
 */
export function getProjectIdByName(name: string): string | null {
  const db = getDatabase();
  const row = db.query("SELECT id FROM projects WHERE name = ?").get(name) as { id: string } | null;
  return row?.id || null;
}

/**
 * Get all cached issue IDs
 */
export function getAllCachedIssueIds(): string[] {
  const db = getDatabase();
  const rows = db.query("SELECT local_id FROM issues").all() as Array<{ local_id: string }>;
  return rows.map((r) => r.local_id);
}

/**
 * Prune issues that are no longer in the remote (stale).
 * Called after full sync to remove issues that were deleted or moved out of scope.
 * @param validIds Set of remote linear identifiers that are still valid
 * @returns Number of issues pruned
 */
export function pruneStaleIssues(validIds: Set<string>): number {
  const db = getDatabase();
  const rows = db
    .query("SELECT local_id, linear_identifier, sync_status FROM issues")
    .all() as Array<{
    local_id: string;
    linear_identifier: string | null;
    sync_status: "synced" | "pending" | "failed" | null;
  }>;
  let pruned = 0;

  runWithBusyRetry(() => {
    for (const row of rows) {
      const syncStatus = row.sync_status || "synced";
      if (syncStatus !== "synced") {
        continue;
      }
      if (!row.linear_identifier) {
        continue;
      }
      if (!validIds.has(row.linear_identifier)) {
        db.run("DELETE FROM issues WHERE local_id = ?", [row.local_id]);
        db.run("DELETE FROM dependencies WHERE issue_id = ? OR depends_on_id = ?", [
          row.local_id,
          row.local_id,
        ]);
        pruned++;
      }
    }
  });

  if (pruned > 0) {
    requestJsonlExport();
  }

  return pruned;
}

/**
 * Store mapping from local ID to Linear ID (identifier)
 */
export function setIssueIdMapping(localId: string, linearId: string): void {
  const db = getDatabase();
  runWithBusyRetry(() => {
    db.run(
      `
    INSERT OR REPLACE INTO issue_id_map (local_id, linear_id, created_at)
    VALUES (?, ?, ?)
  `,
      [localId, linearId, new Date().toISOString()]
    );
  });
}

/**
 * Resolve local ID to Linear ID (identifier)
 */
export function getIssueIdMapping(localId: string): string | null {
  const db = getDatabase();
  const row = db.query("SELECT linear_id FROM issue_id_map WHERE local_id = ?").get(localId) as {
    linear_id: string;
  } | null;
  return row?.linear_id || null;
}

export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}

function normalizeIssueNumber(raw: string): string {
  const noLeadingZeros = raw.replace(/^0+(?=\d)/, "");
  return noLeadingZeros.length > 0 ? noLeadingZeros : "0";
}

function inferTeamPrefixForIssueNumber(issueNumber: string): string {
  const configuredTeamKey = getTeamKey()?.trim().toUpperCase();
  const db = getDatabase();
  const suffixNumber = parseInt(issueNumber, 10);

  const exactMatchPrefixes = runWithBusyRetry(
    () =>
      db
        .query(
          `
        SELECT DISTINCT UPPER(substr(COALESCE(linear_identifier, local_id), 1, instr(COALESCE(linear_identifier, local_id), '-') - 1)) AS prefix
        FROM issues
        WHERE instr(COALESCE(linear_identifier, local_id), '-') > 1
          AND CAST(substr(COALESCE(linear_identifier, local_id), instr(COALESCE(linear_identifier, local_id), '-') + 1) AS INTEGER) = ?
        UNION
        SELECT DISTINCT UPPER(substr(linear_id, 1, instr(linear_id, '-') - 1)) AS prefix
        FROM issue_id_map
        WHERE instr(linear_id, '-') > 1
          AND CAST(substr(linear_id, instr(linear_id, '-') + 1) AS INTEGER) = ?
      `
        )
        .all(suffixNumber, suffixNumber) as Array<{ prefix: string }>
  );

  const cachedPrefixes = runWithBusyRetry(
    () =>
      db
        .query(
          `
        SELECT DISTINCT UPPER(substr(COALESCE(linear_identifier, local_id), 1, instr(COALESCE(linear_identifier, local_id), '-') - 1)) AS prefix
        FROM issues
        WHERE instr(COALESCE(linear_identifier, local_id), '-') > 1
        UNION
        SELECT DISTINCT UPPER(substr(linear_id, 1, instr(linear_id, '-') - 1)) AS prefix
        FROM issue_id_map
        WHERE instr(linear_id, '-') > 1
      `
        )
        .all() as Array<{ prefix: string }>
  );

  const candidates = new Set<string>();
  if (configuredTeamKey) {
    candidates.add(configuredTeamKey);
  }
  for (const row of exactMatchPrefixes) {
    if (row.prefix) {
      candidates.add(row.prefix);
    }
  }

  if (!configuredTeamKey && candidates.size === 0) {
    for (const row of cachedPrefixes) {
      if (row.prefix) {
        candidates.add(row.prefix);
      }
    }
  }

  if (candidates.size === 1) {
    return [...candidates][0];
  }

  const choices = [...candidates].sort();
  if (choices.length > 1) {
    throw new Error(
      `Issue reference '${issueNumber}' is ambiguous. Use one of: ${choices.map((p) => `${p}-${normalizeIssueNumber(issueNumber)}`).join(", ")}`
    );
  }

  throw new Error(
    `Cannot infer team prefix for '${issueNumber}'. Set LB_TEAM_KEY or provide a full issue ID like TEAM-${normalizeIssueNumber(issueNumber)}.`
  );
}

function normalizeIssueInputId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return trimmed;

  const localDashedMatch = trimmed.match(LOCAL_ID_WITH_DASH_RE);
  if (localDashedMatch) {
    return `LOCAL-${localDashedMatch[1]}`;
  }

  if (isLocalId(trimmed)) {
    return trimmed;
  }

  const dashedMatch = trimmed.match(LINEAR_ID_WITH_DASH_RE);
  if (dashedMatch) {
    return `${dashedMatch[1].toUpperCase()}-${normalizeIssueNumber(dashedMatch[2])}`;
  }

  const compactMatch = trimmed.match(LINEAR_ID_NO_DASH_RE);
  if (compactMatch) {
    return `${compactMatch[1].toUpperCase()}-${normalizeIssueNumber(compactMatch[2])}`;
  }

  if (NUMERIC_ISSUE_ID_RE.test(trimmed)) {
    const prefix = inferTeamPrefixForIssueNumber(trimmed);
    return `${prefix}-${normalizeIssueNumber(trimmed)}`;
  }

  return trimmed;
}

/**
 * Resolve an input ID to canonical local_id.
 */
export function resolveIssueLocalId(id: string): string {
  const normalizedId = normalizeIssueInputId(id);
  const db = getDatabase();

  const direct = db
    .query("SELECT local_id FROM issues WHERE local_id = ? OR linear_identifier = ? LIMIT 1")
    .get(normalizedId, normalizedId) as { local_id: string } | null;
  if (direct?.local_id) {
    return direct.local_id;
  }

  if (isLocalId(normalizedId)) {
    const mappedLinear = getIssueIdMapping(normalizedId);
    if (mappedLinear) {
      const mappedRow = db
        .query("SELECT local_id FROM issues WHERE local_id = ? OR linear_identifier = ? LIMIT 1")
        .get(mappedLinear, mappedLinear) as { local_id: string } | null;
      if (mappedRow?.local_id) {
        return mappedRow.local_id;
      }
      return normalizedId;
    }
  }

  return normalizedId;
}

export function getLinearIdentifierForLocalId(localId: string): string | null {
  const db = getDatabase();
  const row = db.query("SELECT linear_identifier FROM issues WHERE local_id = ?").get(localId) as {
    linear_identifier: string | null;
  } | null;
  return row?.linear_identifier || null;
}

export function getLinearIdForLocalId(localId: string): string | null {
  const db = getDatabase();
  const row = db.query("SELECT linear_id FROM issues WHERE local_id = ?").get(localId) as {
    linear_id: string | null;
  } | null;
  return row?.linear_id || null;
}

/**
 * Resolve input ID to a remote-friendly identifier (LIN-123 when available).
 */
export function resolveIssueId(id: string): string {
  const localId = resolveIssueLocalId(id);
  const linearIdentifier = getLinearIdentifierForLocalId(localId);
  if (linearIdentifier) {
    return linearIdentifier;
  }
  if (isLocalId(localId)) {
    return getIssueIdMapping(localId) || localId;
  }
  return localId;
}

/**
 * Resolve Linear ID (identifier) back to local ID
 */
export function getLocalIdForLinearId(linearId: string): string | null {
  const db = getDatabase();
  const row = db
    .query("SELECT local_id FROM issues WHERE linear_identifier = ? OR local_id = ? LIMIT 1")
    .get(linearId, linearId) as { local_id: string } | null;
  if (row?.local_id) {
    return row.local_id;
  }

  const legacy = db
    .query("SELECT local_id FROM issue_id_map WHERE linear_id = ?")
    .get(linearId) as {
    local_id: string;
  } | null;
  return legacy?.local_id || null;
}

/**
 * Format issue ID to include local ID when available
 */
export function getDisplayId(id: string): string {
  const localId = resolveIssueLocalId(id);
  const linearIdentifier = getLinearIdentifierForLocalId(localId);
  if (linearIdentifier) {
    return linearIdentifier;
  }
  if (isLocalId(localId)) {
    return getIssueIdMapping(localId) || localId;
  }
  return localId;
}

/**
 * Attach remote identifiers to a stable local issue row after sync.
 */
export function replaceIssueId(localId: string, linearIdentifier: string, linearId?: string): void {
  const db = getDatabase();
  const resolvedLocalId = resolveIssueLocalId(localId);
  const sourceLocalId = localId;

  runWithBusyRetry(() => {
    const existingForLinear = db
      .query("SELECT local_id FROM issues WHERE linear_identifier = ? AND local_id != ? LIMIT 1")
      .get(linearIdentifier, resolvedLocalId) as { local_id: string } | null;

    if (existingForLinear?.local_id) {
      db.run("UPDATE dependencies SET issue_id = ? WHERE issue_id = ?", [
        resolvedLocalId,
        existingForLinear.local_id,
      ]);
      db.run("UPDATE dependencies SET depends_on_id = ? WHERE depends_on_id = ?", [
        resolvedLocalId,
        existingForLinear.local_id,
      ]);
      db.run("DELETE FROM issues WHERE local_id = ?", [existingForLinear.local_id]);
    }

    if (linearIdentifier !== resolvedLocalId) {
      db.run(
        `
        INSERT OR IGNORE INTO dependencies (issue_id, depends_on_id, type, created_at, created_by)
        SELECT ?, depends_on_id, type, created_at, created_by
        FROM dependencies
        WHERE issue_id = ?
      `,
        [resolvedLocalId, linearIdentifier]
      );
      db.run("DELETE FROM dependencies WHERE issue_id = ?", [linearIdentifier]);

      db.run(
        `
        INSERT OR IGNORE INTO dependencies (issue_id, depends_on_id, type, created_at, created_by)
        SELECT issue_id, ?, type, created_at, created_by
        FROM dependencies
        WHERE depends_on_id = ?
      `,
        [resolvedLocalId, linearIdentifier]
      );
      db.run("DELETE FROM dependencies WHERE depends_on_id = ?", [linearIdentifier]);
    }

    db.run(
      `
      UPDATE issues
      SET linear_identifier = ?,
          linear_id = COALESCE(?, linear_id),
          sync_status = 'synced',
          updated_at = ?
      WHERE local_id = ?
    `,
      [linearIdentifier, linearId || null, new Date().toISOString(), resolvedLocalId]
    );

    db.run(
      `
      INSERT OR REPLACE INTO issue_id_map (local_id, linear_id, created_at)
      VALUES (?, ?, ?)
    `,
      [resolvedLocalId, linearIdentifier, new Date().toISOString()]
    );

    db.run("UPDATE outbox SET local_id = ? WHERE local_id = ? OR local_id = ?", [
      resolvedLocalId,
      resolvedLocalId,
      sourceLocalId,
    ]);
  });

  requestJsonlExport();
}

/**
 * Cache viewer info (current user)
 */
export function cacheViewer(viewer: { id: string; email: string; name: string }): void {
  const db = getDatabase();
  runWithBusyRetry(() => {
    db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('viewer', ?)", [
      JSON.stringify(viewer),
    ]);
  });
}

/**
 * Get cached viewer info (returns null if not cached)
 */
export function getCachedViewer(): { id: string; email: string; name: string } | null {
  const db = getDatabase();
  const row = db.query("SELECT value FROM metadata WHERE key = 'viewer'").get() as {
    value: string;
  } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function sanitizePreferredHandle(handle?: string): string | null {
  if (!handle) return null;
  const cleaned = handle.replace(HANDLE_SANITIZE_RE, "");
  if (!cleaned) return null;
  return cleaned.slice(0, 64);
}

function randomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

function randomHandleBase(): string {
  const adjective = AGENT_ADJECTIVES[randomInt(AGENT_ADJECTIVES.length)];
  const noun = AGENT_NOUNS[randomInt(AGENT_NOUNS.length)];
  return `${adjective}${noun}`;
}

function handleExists(handle: string): boolean {
  const db = getDatabase();
  const row = runWithBusyRetry(
    () =>
      db.query("SELECT 1 as hit FROM agents WHERE handle = ? LIMIT 1").get(handle) as {
        hit: 1;
      } | null
  );
  return !!row;
}

function nextUniqueHandle(preferredHandle?: string): string {
  const preferred = sanitizePreferredHandle(preferredHandle);
  if (preferred && !handleExists(preferred)) {
    return preferred;
  }

  // Try random adjective+noun first for readability.
  for (let i = 0; i < 50; i++) {
    const candidate = randomHandleBase();
    if (!handleExists(candidate)) {
      return candidate;
    }
  }

  // Fall back to deterministic numeric suffixes if random attempts collide.
  const fallbackBase = preferred || randomHandleBase();
  for (let suffix = 2; suffix < 10000; suffix++) {
    const candidate = `${fallbackBase}${suffix}`;
    if (!handleExists(candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to allocate unique agent handle");
}

function nowIso(): string {
  return new Date().toISOString();
}

function toMailRecipientKind(raw: string): MailRecipientKind {
  if ((MAIL_RECIPIENT_KINDS as readonly string[]).includes(raw)) {
    return raw as MailRecipientKind;
  }
  throw new Error(`Invalid mail recipient kind: ${raw}`);
}

export function registerAgent(
  options: {
    preferredHandle?: string;
    displayName?: string;
    pubkey?: string;
  } = {}
): AgentIdentity {
  const db = getDatabase();
  const id = crypto.randomUUID();
  const handle = nextUniqueHandle(options.preferredHandle);
  const createdAt = nowIso();
  const displayName = options.displayName?.trim() || null;
  const pubkey = options.pubkey?.trim() || null;

  runWithBusyRetry(() => {
    db.run(
      `
      INSERT INTO agents (id, handle, display_name, pubkey, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [id, handle, displayName, pubkey, createdAt, createdAt]
    );
  });

  return {
    id,
    handle,
    display_name: displayName || undefined,
    pubkey: pubkey || undefined,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export function getAgentByHandle(handle: string): AgentIdentity | null {
  const db = getDatabase();
  const row = runWithBusyRetry(
    () =>
      db
        .query(
          `
          SELECT id, handle, display_name, pubkey, created_at, updated_at
          FROM agents
          WHERE handle = ?
          LIMIT 1
          `
        )
        .get(handle) as {
        id: string;
        handle: string;
        display_name: string | null;
        pubkey: string | null;
        created_at: string;
        updated_at: string;
      } | null
  );

  if (!row) return null;
  return {
    id: row.id,
    handle: row.handle,
    display_name: row.display_name || undefined,
    pubkey: row.pubkey || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getAgentById(id: string): AgentIdentity | null {
  const db = getDatabase();
  const row = runWithBusyRetry(
    () =>
      db
        .query(
          `
          SELECT id, handle, display_name, pubkey, created_at, updated_at
          FROM agents
          WHERE id = ?
          LIMIT 1
          `
        )
        .get(id) as {
        id: string;
        handle: string;
        display_name: string | null;
        pubkey: string | null;
        created_at: string;
        updated_at: string;
      } | null
  );

  if (!row) return null;
  return {
    id: row.id,
    handle: row.handle,
    display_name: row.display_name || undefined,
    pubkey: row.pubkey || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listAgents(): AgentIdentity[] {
  const db = getDatabase();
  const rows = runWithBusyRetry(
    () =>
      db
        .query(
          `
          SELECT id, handle, display_name, pubkey, created_at, updated_at
          FROM agents
          ORDER BY created_at ASC
          `
        )
        .all() as Array<{
        id: string;
        handle: string;
        display_name: string | null;
        pubkey: string | null;
        created_at: string;
        updated_at: string;
      }>
  );

  return rows.map((row) => ({
    id: row.id,
    handle: row.handle,
    display_name: row.display_name || undefined,
    pubkey: row.pubkey || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export function setCurrentAgentHandle(handle: string): void {
  const db = getDatabase();
  runWithBusyRetry(() => {
    db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('current_agent_handle', ?)", [
      handle,
    ]);
  });
}

export function getCurrentAgentHandle(): string | null {
  const db = getDatabase();
  const row = runWithBusyRetry(
    () =>
      db.query("SELECT value FROM metadata WHERE key = 'current_agent_handle'").get() as {
        value: string;
      } | null
  );
  return row?.value || null;
}

export function createThreadIfNeeded(input: {
  threadId?: string;
  subject?: string;
  workItemRef?: string;
}): MailThread {
  const db = getDatabase();
  const now = nowIso();
  const subject = input.subject?.trim() || null;
  const workItemRef = input.workItemRef?.trim() || null;
  const threadId = (input.threadId?.trim() || crypto.randomUUID()).slice(0, 128);

  runWithBusyRetry(() => {
    db.run(
      `
      INSERT INTO mail_threads (id, work_item_ref, subject, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        work_item_ref = COALESCE(excluded.work_item_ref, mail_threads.work_item_ref),
        subject = COALESCE(excluded.subject, mail_threads.subject),
        updated_at = excluded.updated_at
      `,
      [threadId, workItemRef, subject, now, now]
    );
  });

  const row = runWithBusyRetry(
    () =>
      db
        .query(
          `
          SELECT id, work_item_ref, subject, created_at, updated_at
          FROM mail_threads
          WHERE id = ?
          `
        )
        .get(threadId) as {
        id: string;
        work_item_ref: string | null;
        subject: string | null;
        created_at: string;
        updated_at: string;
      }
  );

  return {
    id: row.id,
    work_item_ref: row.work_item_ref || undefined,
    subject: row.subject || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getMailThreadById(threadId: string): MailThread | null {
  const db = getDatabase();
  const row = runWithBusyRetry(
    () =>
      db
        .query(
          `
          SELECT id, work_item_ref, subject, created_at, updated_at
          FROM mail_threads
          WHERE id = ?
          LIMIT 1
          `
        )
        .get(threadId) as {
        id: string;
        work_item_ref: string | null;
        subject: string | null;
        created_at: string;
        updated_at: string;
      } | null
  );

  if (!row) return null;
  return {
    id: row.id,
    work_item_ref: row.work_item_ref || undefined,
    subject: row.subject || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function addRecipients(
  messageId: string,
  recipients: Array<{ recipientAgentId: string; kind: MailRecipientKind }>
): MailRecipient[] {
  if (recipients.length === 0) return [];
  const db = getDatabase();
  const deliveredAt = nowIso();

  runWithBusyRetry(() => {
    const tx = db.transaction(() => {
      for (const recipient of recipients) {
        db.run(
          `
          INSERT INTO mail_recipients (message_id, recipient_agent_id, kind, delivered_at, read_at, ack_at)
          VALUES (?, ?, ?, ?, NULL, NULL)
          ON CONFLICT(message_id, recipient_agent_id, kind) DO UPDATE SET
            delivered_at = COALESCE(mail_recipients.delivered_at, excluded.delivered_at)
          `,
          [messageId, recipient.recipientAgentId, recipient.kind, deliveredAt]
        );
      }
    });
    tx();
  });

  const placeholders = recipients.map(() => "(?, ?, ?)").join(",");
  const params: string[] = [];
  for (const recipient of recipients) {
    params.push(messageId, recipient.recipientAgentId, recipient.kind);
  }
  const rows = runWithBusyRetry(
    () =>
      db
        .query(
          `
          SELECT message_id, recipient_agent_id, kind, delivered_at, read_at, ack_at
          FROM mail_recipients
          WHERE (message_id, recipient_agent_id, kind) IN (${placeholders})
          `
        )
        .all(...params) as Array<{
        message_id: string;
        recipient_agent_id: string;
        kind: string;
        delivered_at: string | null;
        read_at: string | null;
        ack_at: string | null;
      }>
  );

  return rows.map((row) => ({
    message_id: row.message_id,
    recipient_agent_id: row.recipient_agent_id,
    kind: toMailRecipientKind(row.kind),
    delivered_at: row.delivered_at || undefined,
    read_at: row.read_at || undefined,
    ack_at: row.ack_at || undefined,
  }));
}

export function storeMessage(input: {
  threadId?: string;
  senderAgentId: string;
  subject: string;
  bodyMd: string;
  replyToMessageId?: string;
  syncStatus?: "synced" | "pending" | "failed";
  workItemRef?: string;
  recipients: Array<{ recipientAgentId: string; kind: MailRecipientKind }>;
}): { thread: MailThread; message: MailMessage; recipients: MailRecipient[] } {
  const db = getDatabase();
  const now = nowIso();
  const messageId = crypto.randomUUID();
  const syncStatus = input.syncStatus || "synced";
  const thread = createThreadIfNeeded({
    threadId: input.threadId,
    subject: input.subject,
    workItemRef: input.workItemRef,
  });

  runWithBusyRetry(() => {
    const tx = db.transaction(() => {
      db.run(
        `
        INSERT INTO mail_messages
          (id, thread_id, sender_agent_id, subject, body_md, created_at, reply_to_message_id, sync_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          messageId,
          thread.id,
          input.senderAgentId,
          input.subject,
          input.bodyMd,
          now,
          input.replyToMessageId || null,
          syncStatus,
        ]
      );

      for (const recipient of input.recipients) {
        db.run(
          `
          INSERT INTO mail_recipients (message_id, recipient_agent_id, kind, delivered_at, read_at, ack_at)
          VALUES (?, ?, ?, ?, NULL, NULL)
          `,
          [messageId, recipient.recipientAgentId, recipient.kind, now]
        );
      }
    });
    tx();
  });

  const recipients = input.recipients.map((recipient) => ({
    message_id: messageId,
    recipient_agent_id: recipient.recipientAgentId,
    kind: recipient.kind,
    delivered_at: now,
    read_at: undefined,
    ack_at: undefined,
  }));

  const message: MailMessage = {
    id: messageId,
    thread_id: thread.id,
    sender_agent_id: input.senderAgentId,
    subject: input.subject,
    body_md: input.bodyMd,
    created_at: now,
    reply_to_message_id: input.replyToMessageId,
    sync_status: syncStatus,
  };

  return { thread, message, recipients };
}

export function fetchInbox(
  agentId: string,
  options: { since?: string; unreadOnly?: boolean; limit?: number } = {}
): Array<{
  message: MailMessage;
  recipient: MailRecipient;
  thread?: MailThread;
}> {
  const db = getDatabase();
  const limit = Math.max(1, Math.min(500, options.limit ?? 50));
  const conditions = ["r.recipient_agent_id = ?"];
  const params: Array<string | number> = [agentId];

  if (options.unreadOnly) {
    conditions.push("r.read_at IS NULL");
  }
  if (options.since) {
    conditions.push("m.created_at > ?");
    params.push(options.since);
  }
  params.push(limit);

  const rows = runWithBusyRetry(
    () =>
      db
        .query(
          `
          SELECT
            m.id AS message_id,
            m.thread_id,
            m.sender_agent_id,
            m.subject,
            m.body_md,
            m.created_at AS message_created_at,
            m.reply_to_message_id,
            m.sync_status,
            r.kind,
            r.delivered_at,
            r.read_at,
            r.ack_at,
            t.work_item_ref,
            t.subject AS thread_subject,
            t.created_at AS thread_created_at,
            t.updated_at AS thread_updated_at
          FROM mail_recipients r
          JOIN mail_messages m ON m.id = r.message_id
          LEFT JOIN mail_threads t ON t.id = m.thread_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY m.created_at DESC
          LIMIT ?
          `
        )
        .all(...params) as Array<{
        message_id: string;
        thread_id: string;
        sender_agent_id: string;
        subject: string;
        body_md: string;
        message_created_at: string;
        reply_to_message_id: string | null;
        sync_status: "synced" | "pending" | "failed";
        kind: string;
        delivered_at: string | null;
        read_at: string | null;
        ack_at: string | null;
        work_item_ref: string | null;
        thread_subject: string | null;
        thread_created_at: string | null;
        thread_updated_at: string | null;
      }>
  );

  return rows.map((row) => ({
    message: {
      id: row.message_id,
      thread_id: row.thread_id,
      sender_agent_id: row.sender_agent_id,
      subject: row.subject,
      body_md: row.body_md,
      created_at: row.message_created_at,
      reply_to_message_id: row.reply_to_message_id || undefined,
      sync_status: row.sync_status,
    },
    recipient: {
      message_id: row.message_id,
      recipient_agent_id: agentId,
      kind: toMailRecipientKind(row.kind),
      delivered_at: row.delivered_at || undefined,
      read_at: row.read_at || undefined,
      ack_at: row.ack_at || undefined,
    },
    thread:
      row.thread_created_at && row.thread_updated_at
        ? {
            id: row.thread_id,
            work_item_ref: row.work_item_ref || undefined,
            subject: row.thread_subject || undefined,
            created_at: row.thread_created_at,
            updated_at: row.thread_updated_at,
          }
        : undefined,
  }));
}

export function markMessageRead(
  agentId: string,
  messageId: string
): {
  messageId: string;
  readAt: string;
  updated: number;
} {
  const db = getDatabase();
  const readAt = nowIso();

  const updated = runWithBusyRetry(() => {
    db.run(
      `
      UPDATE mail_recipients
      SET read_at = COALESCE(read_at, ?)
      WHERE recipient_agent_id = ? AND message_id = ?
      `,
      [readAt, agentId, messageId]
    );
    const row = db.query("SELECT changes() as count").get() as { count: number };
    return row.count;
  });

  return { messageId, readAt, updated };
}

export function ackMessage(
  agentId: string,
  messageId: string
): {
  messageId: string;
  readAt: string;
  ackAt: string;
  updated: number;
} {
  const db = getDatabase();
  const now = nowIso();

  const updated = runWithBusyRetry(() => {
    db.run(
      `
      UPDATE mail_recipients
      SET
        read_at = COALESCE(read_at, ?),
        ack_at = COALESCE(ack_at, ?)
      WHERE recipient_agent_id = ? AND message_id = ?
      `,
      [now, now, agentId, messageId]
    );
    const row = db.query("SELECT changes() as count").get() as { count: number };
    return row.count;
  });

  return { messageId, readAt: now, ackAt: now, updated };
}

export function fetchThread(threadId: string): {
  thread: MailThread | null;
  messages: Array<MailMessage & { recipients: MailRecipient[] }>;
} {
  const db = getDatabase();
  const threadRow = runWithBusyRetry(
    () =>
      db
        .query(
          `
          SELECT id, work_item_ref, subject, created_at, updated_at
          FROM mail_threads
          WHERE id = ?
          `
        )
        .get(threadId) as {
        id: string;
        work_item_ref: string | null;
        subject: string | null;
        created_at: string;
        updated_at: string;
      } | null
  );

  if (!threadRow) {
    return { thread: null, messages: [] };
  }

  const messageRows = runWithBusyRetry(
    () =>
      db
        .query(
          `
          SELECT id, thread_id, sender_agent_id, subject, body_md, created_at, reply_to_message_id, sync_status
          FROM mail_messages
          WHERE thread_id = ?
          ORDER BY created_at ASC
          `
        )
        .all(threadId) as Array<{
        id: string;
        thread_id: string;
        sender_agent_id: string;
        subject: string;
        body_md: string;
        created_at: string;
        reply_to_message_id: string | null;
        sync_status: "synced" | "pending" | "failed";
      }>
  );

  const recipientsByMessage = new Map<string, MailRecipient[]>();
  const messageIds = messageRows.map((row) => row.id);
  if (messageIds.length > 0) {
    const placeholders = messageIds.map(() => "?").join(",");
    const recipientRows = runWithBusyRetry(
      () =>
        db
          .query(
            `
            SELECT message_id, recipient_agent_id, kind, delivered_at, read_at, ack_at
            FROM mail_recipients
            WHERE message_id IN (${placeholders})
            ORDER BY message_id ASC
            `
          )
          .all(...messageIds) as Array<{
          message_id: string;
          recipient_agent_id: string;
          kind: string;
          delivered_at: string | null;
          read_at: string | null;
          ack_at: string | null;
        }>
    );

    for (const row of recipientRows) {
      const recipients = recipientsByMessage.get(row.message_id) || [];
      recipients.push({
        message_id: row.message_id,
        recipient_agent_id: row.recipient_agent_id,
        kind: toMailRecipientKind(row.kind),
        delivered_at: row.delivered_at || undefined,
        read_at: row.read_at || undefined,
        ack_at: row.ack_at || undefined,
      });
      recipientsByMessage.set(row.message_id, recipients);
    }
  }

  const messages = messageRows.map((row) => ({
    id: row.id,
    thread_id: row.thread_id,
    sender_agent_id: row.sender_agent_id,
    subject: row.subject,
    body_md: row.body_md,
    created_at: row.created_at,
    reply_to_message_id: row.reply_to_message_id || undefined,
    sync_status: row.sync_status,
    recipients: recipientsByMessage.get(row.id) || [],
  }));

  return {
    thread: {
      id: threadRow.id,
      work_item_ref: threadRow.work_item_ref || undefined,
      subject: threadRow.subject || undefined,
      created_at: threadRow.created_at,
      updated_at: threadRow.updated_at,
    },
    messages,
  };
}

export function getMailMessageById(
  messageId: string
): (MailMessage & { recipients: MailRecipient[] }) | null {
  const db = getDatabase();
  const row = runWithBusyRetry(
    () =>
      db
        .query(
          `
          SELECT id, thread_id, sender_agent_id, subject, body_md, created_at, reply_to_message_id, sync_status
          FROM mail_messages
          WHERE id = ?
          LIMIT 1
          `
        )
        .get(messageId) as {
        id: string;
        thread_id: string;
        sender_agent_id: string;
        subject: string;
        body_md: string;
        created_at: string;
        reply_to_message_id: string | null;
        sync_status: "synced" | "pending" | "failed";
      } | null
  );
  if (!row) return null;

  const recipients = runWithBusyRetry(
    () =>
      db
        .query(
          `
          SELECT message_id, recipient_agent_id, kind, delivered_at, read_at, ack_at
          FROM mail_recipients
          WHERE message_id = ?
          ORDER BY kind, recipient_agent_id
          `
        )
        .all(messageId) as Array<{
        message_id: string;
        recipient_agent_id: string;
        kind: string;
        delivered_at: string | null;
        read_at: string | null;
        ack_at: string | null;
      }>
  ).map((recipient) => ({
    message_id: recipient.message_id,
    recipient_agent_id: recipient.recipient_agent_id,
    kind: toMailRecipientKind(recipient.kind),
    delivered_at: recipient.delivered_at || undefined,
    read_at: recipient.read_at || undefined,
    ack_at: recipient.ack_at || undefined,
  }));

  return {
    id: row.id,
    thread_id: row.thread_id,
    sender_agent_id: row.sender_agent_id,
    subject: row.subject,
    body_md: row.body_md,
    created_at: row.created_at,
    reply_to_message_id: row.reply_to_message_id || undefined,
    sync_status: row.sync_status,
    recipients,
  };
}

export function updateMailMessageSyncStatus(
  messageId: string,
  syncStatus: "synced" | "pending" | "failed"
): number {
  const db = getDatabase();
  return runWithBusyRetry(() => {
    db.run("UPDATE mail_messages SET sync_status = ? WHERE id = ?", [syncStatus, messageId]);
    const row = db.query("SELECT changes() as count").get() as { count: number };
    return row.count;
  });
}

export function getMailSyncCursor(backend: string): string | null {
  const db = getDatabase();
  const row = runWithBusyRetry(
    () =>
      db
        .query(
          `
          SELECT cursor
          FROM mail_sync_state
          WHERE backend = ?
          LIMIT 1
          `
        )
        .get(backend) as { cursor: string | null } | null
  );
  return row?.cursor || null;
}

export function setMailSyncCursor(backend: string, cursor: string | null): void {
  const db = getDatabase();
  runWithBusyRetry(() => {
    db.run(
      `
      INSERT INTO mail_sync_state (backend, cursor, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(backend) DO UPDATE SET
        cursor = excluded.cursor,
        updated_at = excluded.updated_at
      `,
      [backend, cursor, nowIso()]
    );
  });
}

export function upsertMailMessageFromSync(input: {
  messageId: string;
  threadId: string;
  senderAgentId: string;
  subject: string;
  bodyMd: string;
  createdAt: string;
  replyToMessageId?: string;
  workItemRef?: string;
  recipients: Array<{ recipientAgentId: string; kind: MailRecipientKind }>;
}): { inserted: boolean; message: MailMessage; recipients: MailRecipient[] } {
  const db = getDatabase();

  const existing = runWithBusyRetry(
    () =>
      db
        .query(
          `
          SELECT id
          FROM mail_messages
          WHERE id = ?
          LIMIT 1
          `
        )
        .get(input.messageId) as { id: string } | null
  );

  createThreadIfNeeded({
    threadId: input.threadId,
    subject: input.subject,
    workItemRef: input.workItemRef,
  });

  runWithBusyRetry(() => {
    db.run(
      `
      INSERT INTO mail_messages
        (id, thread_id, sender_agent_id, subject, body_md, created_at, reply_to_message_id, sync_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'synced')
      ON CONFLICT(id) DO UPDATE SET
        thread_id = excluded.thread_id,
        sender_agent_id = excluded.sender_agent_id,
        subject = excluded.subject,
        body_md = excluded.body_md,
        created_at = excluded.created_at,
        reply_to_message_id = excluded.reply_to_message_id,
        sync_status = 'synced'
      `,
      [
        input.messageId,
        input.threadId,
        input.senderAgentId,
        input.subject,
        input.bodyMd,
        input.createdAt,
        input.replyToMessageId || null,
      ]
    );
  });

  const recipients = addRecipients(input.messageId, input.recipients);
  return {
    inserted: !existing,
    message: {
      id: input.messageId,
      thread_id: input.threadId,
      sender_agent_id: input.senderAgentId,
      subject: input.subject,
      body_md: input.bodyMd,
      created_at: input.createdAt,
      reply_to_message_id: input.replyToMessageId,
      sync_status: "synced",
    },
    recipients,
  };
}

/**
 * Close database, ensuring WAL is checkpointed
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
