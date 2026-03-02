import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { getDbPath } from "./config.js";

export const LATEST_DB_SCHEMA_VERSION = 7;
export const LOCAL_ID_SCHEMA_VERSION = 6;

export type LocalSchemaStatus = {
  db_path: string;
  db_exists: boolean;
  schema_version: number;
  latest_schema_version: number;
  migrated_to_local_ids: boolean;
  up_to_date: boolean;
  needs_migration: boolean;
};

function readUserVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("PRAGMA user_version").get() as { user_version?: number } | null;
    return row?.user_version ?? 0;
  } finally {
    db.close();
  }
}

export function getLocalSchemaStatus(): LocalSchemaStatus {
  const dbPath = getDbPath();
  const dbExists = existsSync(dbPath);
  const schemaVersion = dbExists ? readUserVersion(dbPath) : 0;
  const migratedToLocalIds = schemaVersion >= LOCAL_ID_SCHEMA_VERSION;
  const upToDate = schemaVersion >= LATEST_DB_SCHEMA_VERSION;
  const needsMigration = dbExists && schemaVersion < LATEST_DB_SCHEMA_VERSION;

  return {
    db_path: dbPath,
    db_exists: dbExists,
    schema_version: schemaVersion,
    latest_schema_version: LATEST_DB_SCHEMA_VERSION,
    migrated_to_local_ids: migratedToLocalIds,
    up_to_date: upToDate,
    needs_migration: needsMigration,
  };
}
