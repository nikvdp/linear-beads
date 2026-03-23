import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tempDirs: string[] = [];
const DATABASE_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "database.ts");
const OUTBOX_PROCESSOR_PATH = join(import.meta.dir, "..", "src", "utils", "outbox-processor.ts");
const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

setDefaultTimeout(10000);

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-outbox-replay-"));
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
  return repoDir;
}

async function runEval(
  cwd: string,
  mode:
    | "mapping"
    | "marker"
    | "orphan"
    | "update_before_create"
    | "orphan_parent"
    | "deps_retry"
    | "deps_retry_prefers_identifier"
    | "legacy_placeholder_refs"
    | "missing_cached_issue_row"
    | "alias_merge_resolution"
    | "shared_parent_resolution"
    | "local_blocker_relation_replays_after_create_resolution"
    | "invalid_issue_refs_are_dropped_from_create_payloads"
    | "self_referential_pending_sync_state"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import { Database } from "bun:sqlite";
    import {
      cacheDependency,
      cacheIssue,
      generateLocalId,
      getDisplayId,
      getIssueIdMapping,
      getPendingOutboxItems,
      resolveIssueId,
      resolveIssueLocalId,
      markOutboxCreateRemoteIssueIdentifier,
      queueOutboxItem,
      setIssueIdMapping,
    } from ${JSON.stringify(DATABASE_UTILS_PATH)};
    import { processOutboxQueue } from ${JSON.stringify(OUTBOX_PROCESSOR_PATH)};

    const mode = process.argv[1];
    const localId = generateLocalId();
    const now = new Date().toISOString();
    const aliasLocalId = mode === "alias_merge_resolution" ? generateLocalId() : null;

    if (aliasLocalId) {
      cacheIssue({
        id: aliasLocalId,
        title: "Alias local issue",
        status: "open",
        priority: 2,
        sync_status: "synced",
        linear_identifier: "LIN-9007",
        created_at: now,
        updated_at: now,
      });
    }

    if (mode !== "orphan") {
      cacheIssue({
        id: localId,
        title: "Replay guard issue",
        status: "open",
        priority: 2,
        sync_status: "pending",
        created_at: now,
        updated_at: now,
      });
    }

    if (mode === "update_before_create") {
      queueOutboxItem("update", { issueId: localId, status: "in_progress" }, localId);
      const createOutboxId = queueOutboxItem(
        "create",
        { title: "Replay guard issue", priority: 2 },
        localId
      );
      markOutboxCreateRemoteIssueIdentifier(createOutboxId, "LIN-9003");
    } else if (mode === "orphan_parent") {
      const createOutboxId = queueOutboxItem(
        "create",
        { title: "Replay guard issue", priority: 2, parentId: "LOCAL-9999" },
        localId
      );
      markOutboxCreateRemoteIssueIdentifier(createOutboxId, "LIN-9004");
    } else if (mode === "deps_retry") {
      const outboxId = queueOutboxItem(
        "create",
        {
          title: "Replay guard issue",
          priority: 2,
          deps: "blocked-by:LIN-9999",
        },
        localId
      );
      markOutboxCreateRemoteIssueIdentifier(outboxId, "LIN-9005");
    } else if (mode === "deps_retry_prefers_identifier") {
      const cachedUuid = "123e4567-e89b-12d3-a456-426614174000";
      const db = new Database(".lb/cache.db");
      db.run("UPDATE issues SET linear_id = ? WHERE local_id = ?", [cachedUuid, localId]);
      db.close();

      const outboxId = queueOutboxItem(
        "create",
        {
          title: "Replay guard issue",
          priority: 2,
          deps: "blocked-by:LIN-9999",
        },
        localId
      );
      markOutboxCreateRemoteIssueIdentifier(outboxId, "LIN-9005");
    } else if (mode === "legacy_placeholder_refs") {
      const outboxId = queueOutboxItem(
        "create",
        {
          title: "Replay guard issue",
          priority: 2,
          parentId: "-",
          deps: "blocked-by:-,blocked-by:undefined,related:null,blocks:LIN-9006",
        },
        localId
      );
      markOutboxCreateRemoteIssueIdentifier(outboxId, "LIN-9006");
    } else if (mode === "missing_cached_issue_row") {
      const outboxId = queueOutboxItem(
        "create",
        {
          title: "Replay guard issue",
          priority: 2,
          parentId: "-",
          syncKey: "fbab0a11-7f0a-4b0f-90ee-52c057826001",
        },
        localId
      );
      markOutboxCreateRemoteIssueIdentifier(outboxId, "LIN-9014");

      const db = new Database(".lb/cache.db");
      db.run("DELETE FROM issues WHERE local_id = ?", [localId]);
      db.run("DELETE FROM dependencies WHERE issue_id = ? OR depends_on_id = ?", [localId, localId]);
      db.close();
    } else if (mode === "alias_merge_resolution") {
      if (!aliasLocalId) {
        throw new Error("Expected aliasLocalId for alias_merge_resolution mode");
      }

      const relatedLocalId = generateLocalId();
      cacheIssue({
        id: relatedLocalId,
        title: "Related issue",
        status: "open",
        priority: 2,
        sync_status: "pending",
        created_at: now,
        updated_at: now,
      });

      const relatedOutboxId = queueOutboxItem(
        "create",
        { title: "Related issue", priority: 2 },
        relatedLocalId
      );
      markOutboxCreateRemoteIssueIdentifier(relatedOutboxId, "LIN-9008");

      const outboxId = queueOutboxItem(
        "create",
        { title: "Replay guard issue", priority: 2 },
        localId
      );
      markOutboxCreateRemoteIssueIdentifier(outboxId, "LIN-9007");

      queueOutboxItem(
        "create_relation",
        { issueId: aliasLocalId, relatedIssueId: relatedLocalId, type: "blocks" },
        aliasLocalId
      );
    } else if (mode === "shared_parent_resolution") {
      const parentLocalId = generateLocalId();
      const siblingLocalId = generateLocalId();
      const blockerLocalId = generateLocalId();

      for (const [id, title] of [
        [parentLocalId, "Shared parent"],
        [siblingLocalId, "Sibling issue"],
        [blockerLocalId, "Blocking issue"],
      ] as const) {
        cacheIssue({
          id,
          title,
          status: "open",
          priority: 2,
          sync_status: "pending",
          created_at: now,
          updated_at: now,
        });
      }

      const parentOutboxId = queueOutboxItem(
        "create",
        { title: "Shared parent", priority: 2 },
        parentLocalId
      );
      markOutboxCreateRemoteIssueIdentifier(parentOutboxId, "LIN-9010");

      const blockedChildOutboxId = queueOutboxItem(
        "create",
        {
          title: "Replay guard issue",
          priority: 2,
          parentId: parentLocalId,
          deps: "blocked-by:" + blockerLocalId,
        },
        localId
      );
      markOutboxCreateRemoteIssueIdentifier(blockedChildOutboxId, "LIN-9011");

      const siblingOutboxId = queueOutboxItem(
        "create",
        {
          title: "Sibling issue",
          priority: 2,
          parentId: parentLocalId,
        },
        siblingLocalId
      );
      markOutboxCreateRemoteIssueIdentifier(siblingOutboxId, "LIN-9012");

      const blockerOutboxId = queueOutboxItem(
        "create",
        { title: "Blocking issue", priority: 2 },
        blockerLocalId
      );
      markOutboxCreateRemoteIssueIdentifier(blockerOutboxId, "LIN-9013");

      const pass1 = await processOutboxQueue("TEAM");
      const pendingAfterPass1 = getPendingOutboxItems().map((item) => ({
        operation: item.operation,
        local_id: item.local_id || null,
      }));
      const pass2 = await processOutboxQueue("TEAM");
      const pendingAfterPass2 = getPendingOutboxItems().map((item) => ({
        operation: item.operation,
        local_id: item.local_id || null,
      }));
      const pass3 = await processOutboxQueue("TEAM");
      const pendingFinal = getPendingOutboxItems().map((item) => ({
        operation: item.operation,
        local_id: item.local_id || null,
      }));
      const db = new Database(".lb/cache.db", { readonly: true });
      const siblingRow = db.query(
        "SELECT local_id, linear_identifier, sync_status FROM issues WHERE local_id = ? LIMIT 1"
      ).get(siblingLocalId) as {
        local_id: string;
        linear_identifier: string | null;
        sync_status: string;
      } | null;
      db.close();

      console.log(
        JSON.stringify({
          pass1,
          pass2,
          pass3,
          pendingAfterPass1,
          pendingAfterPass2,
          pendingFinal,
          siblingLocalId,
          siblingDisplayId: getDisplayId(siblingLocalId),
          siblingRow,
        })
      );
      process.exit(0);
    } else if (mode === "local_blocker_relation_replays_after_create_resolution") {
      const blockedLocalId = localId;
      const blockerLocalId = generateLocalId();

      cacheIssue({
        id: blockerLocalId,
        title: "Blocking issue",
        status: "open",
        priority: 2,
        sync_status: "pending",
        created_at: now,
        updated_at: now,
      });

      queueOutboxItem(
        "create_relation",
        { issueId: blockerLocalId, relatedIssueId: blockedLocalId, type: "blocks" },
        blockerLocalId
      );

      const blockedOutboxId = queueOutboxItem(
        "create",
        { title: "Replay guard issue", priority: 2 },
        blockedLocalId
      );
      markOutboxCreateRemoteIssueIdentifier(blockedOutboxId, "LIN-9015");

      const blockerOutboxId = queueOutboxItem(
        "create",
        { title: "Blocking issue", priority: 2 },
        blockerLocalId
      );
      markOutboxCreateRemoteIssueIdentifier(blockerOutboxId, "LIN-9016");

      const pass1 = await processOutboxQueue("TEAM");
      const pendingAfterPass1 = getPendingOutboxItems().map((item) => ({
        operation: item.operation,
        local_id: item.local_id || null,
        payload: item.payload,
      }));
      const pass2 = await processOutboxQueue("TEAM");
      const pendingAfterPass2 = getPendingOutboxItems().map((item) => ({
        operation: item.operation,
        local_id: item.local_id || null,
        payload: item.payload,
      }));

      console.log(
        JSON.stringify({
          pass1,
          pass2,
          pendingAfterPass1,
          pendingAfterPass2,
          blockedDisplayId: getDisplayId(blockedLocalId),
          blockerDisplayId: getDisplayId(blockerLocalId),
          blockedMapping: getIssueIdMapping(blockedLocalId),
          blockerMapping: getIssueIdMapping(blockerLocalId),
        })
      );
      process.exit(0);
    } else if (mode === "invalid_issue_refs_are_dropped_from_create_payloads") {
      const outboxId = queueOutboxItem(
        "create",
        {
          title: "Replay guard issue",
          priority: 2,
          parentId:
            "Afterthefixworklands,searchinginscopedroutessuchasclips,private,following,team,anduserstreamsshouldpreservebothscopeandqueryinbrowserhistoryandinAPIrequests,anddifferenttermsshouldyieldmeaningfullydifferentresultsets.",
          deps: "blocked-by:AscopedsearchforclipsshouldkeepbothclipscopeandqueryintheURLhistoryandintheoutgoing-api-v1-quests-request.Equivalentbehaviorshouldholdfortheotherscopedsearchmodes.",
        },
        localId
      );
      markOutboxCreateRemoteIssueIdentifier(outboxId, "LIN-9017");

      const result = await processOutboxQueue("TEAM");
      const pending = getPendingOutboxItems().map((item) => ({
        operation: item.operation,
        local_id: item.local_id || null,
        payload: item.payload,
      }));
      const db = new Database(".lb/cache.db", { readonly: true });
      const depRows = db
        .query("SELECT issue_id, depends_on_id, type FROM dependencies WHERE issue_id = ?")
        .all(localId) as Array<{ issue_id: string; depends_on_id: string; type: string }>;
      const row = db.query(
        "SELECT local_id, linear_identifier, sync_status FROM issues WHERE local_id = ? LIMIT 1"
      ).get(localId) as { local_id: string; linear_identifier: string | null; sync_status: string } | null;
      db.close();

      console.log(JSON.stringify({ result, pending, depRows, row, mapping: getIssueIdMapping(localId) }));
      process.exit(0);
    } else if (mode === "self_referential_pending_sync_state") {
      const siblingLocalId = generateLocalId();

      cacheIssue({
        id: siblingLocalId,
        title: "Resolved sibling",
        status: "open",
        priority: 2,
        sync_status: "synced",
        linear_identifier: "LIN-5616",
        created_at: now,
        updated_at: now,
      });

      cacheDependency({
        issue_id: localId,
        depends_on_id: localId,
        type: "blocks",
        created_at: now,
        created_by: "local",
      });
      cacheDependency({
        issue_id: siblingLocalId,
        depends_on_id: localId,
        type: "blocks",
        created_at: now,
        created_by: "local",
      });

      const selfCreateId = queueOutboxItem(
        "create",
        {
          title: "Replay guard issue",
          priority: 2,
          deps: "blocked-by:" + localId,
        },
        localId
      );
      markOutboxCreateRemoteIssueIdentifier(selfCreateId, "LIN-5617");
      queueOutboxItem(
        "delete_relation",
        { issueA: localId, issueB: localId, relationType: "blocks" },
        localId
      );

      const result = await processOutboxQueue("TEAM");
      const pending = getPendingOutboxItems().map((item) => ({
        id: item.id,
        operation: item.operation,
        local_id: item.local_id || null,
        payload: item.payload,
      }));
      const db = new Database(".lb/cache.db", { readonly: true });
      const depRows = db
        .query("SELECT issue_id, depends_on_id, type FROM dependencies ORDER BY issue_id, depends_on_id")
        .all() as Array<{ issue_id: string; depends_on_id: string; type: string }>;
      const row = db.query(
        "SELECT local_id, linear_identifier, sync_status FROM issues WHERE local_id = ? LIMIT 1"
      ).get(localId) as { local_id: string; linear_identifier: string | null; sync_status: string } | null;
      db.close();

      console.log(
        JSON.stringify({
          result,
          pending,
          depRows,
          row,
          mapping: getIssueIdMapping(localId),
          displayId: getDisplayId(localId),
          siblingDisplayId: getDisplayId(siblingLocalId),
          localId,
          siblingLocalId,
        })
      );
      process.exit(0);
    } else {
      const outboxId = queueOutboxItem(
        "create",
        { title: "Replay guard issue", priority: 2 },
        localId
      );
      if (mode === "mapping") {
        setIssueIdMapping(localId, "LIN-9001");
      } else if (mode === "orphan") {
        markOutboxCreateRemoteIssueIdentifier(outboxId, "LIN-9000");
      } else if (mode === "marker") {
        markOutboxCreateRemoteIssueIdentifier(outboxId, "LIN-9002");
      }
    }

    const result = await processOutboxQueue("TEAM");
    const pending = getPendingOutboxItems().map((item) => ({
      id: item.id,
      operation: item.operation,
      local_id: item.local_id || null,
      payload: item.payload,
    }));
    const remaining = pending.length;
    const mapping = getIssueIdMapping(localId);
    const displayId = getDisplayId(localId);
    const alias = aliasLocalId
      ? {
          local_id: aliasLocalId,
          mapping: getIssueIdMapping(aliasLocalId),
          resolved_remote_id: resolveIssueId(aliasLocalId),
          resolved_local_id: resolveIssueLocalId(aliasLocalId),
        }
      : null;
    const uuidResolution = mode === "deps_retry_prefers_identifier"
      ? {
          local_id: resolveIssueLocalId("123e4567-e89b-12d3-a456-426614174000"),
          display_id: getDisplayId("123e4567-e89b-12d3-a456-426614174000"),
        }
      : null;
    const db = new Database(".lb/cache.db", { readonly: true });
    const row = db.query(
      "SELECT local_id, linear_identifier, sync_status FROM issues WHERE local_id = ? LIMIT 1"
    ).get(localId) as { local_id: string; linear_identifier: string | null; sync_status: string } | null;
    db.close();
    console.log(JSON.stringify({ result, remaining, pending, mapping, displayId, row, alias, uuidResolution }));
  `;

  const proc = Bun.spawn(["bun", "--eval", script, mode], {
    cwd,
    env: {
      ...process.env,
      LB_TEAM_KEY: "",
      LINEAR_API_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function runCli(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      LB_TEAM_KEY: "",
      LINEAR_API_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("outbox create replay protection", () => {
  test("skips remote create when local_id is already mapped", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "mapping");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      result: { success: number; failed: number };
      remaining: number;
      pending: Array<{ id: number; operation: string; local_id: string | null; payload: unknown }>;
      mapping: string | null;
      displayId: string;
      row: { local_id: string; linear_identifier: string | null; sync_status: string } | null;
    };
    expect(payload.result.success).toBe(1);
    expect(payload.result.failed).toBe(0);
    expect(payload.remaining).toBe(0);
    expect(payload.mapping).toBe("LIN-9001");
    expect(payload.displayId).toBe("LIN-9001");
    expect(payload.row).not.toBeNull();
    expect(payload.row?.local_id).toMatch(/^LOCAL-/);
    expect(payload.row?.linear_identifier).toBe("LIN-9001");
    expect(payload.row?.sync_status).toBe("synced");
  });

  test("uses persisted outbox remote marker to finalize mapping without re-create", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "marker");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      result: { success: number; failed: number };
      remaining: number;
      pending: Array<{ id: number; operation: string; local_id: string | null; payload: unknown }>;
      mapping: string | null;
      displayId: string;
      row: { local_id: string; linear_identifier: string | null; sync_status: string } | null;
    };
    expect(payload.result.success).toBe(1);
    expect(payload.result.failed).toBe(0);
    expect(payload.remaining).toBe(0);
    expect(payload.mapping).toBe("LIN-9002");
    expect(payload.displayId).toBe("LIN-9002");
    expect(payload.row).not.toBeNull();
    expect(payload.row?.local_id).toMatch(/^LOCAL-/);
    expect(payload.row?.linear_identifier).toBe("LIN-9002");
    expect(payload.row?.sync_status).toBe("synced");
  });

  test("revives orphaned create outbox rows when the payload still contains the issue data", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "orphan");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      result: { success: number; failed: number; remoteProcessed: number };
      remaining: number;
      pending: Array<{ id: number; operation: string; local_id: string | null; payload: unknown }>;
      mapping: string | null;
      displayId: string;
      row: { local_id: string; linear_identifier: string | null; sync_status: string } | null;
    };

    expect(payload.result.success).toBe(1);
    expect(payload.result.failed).toBe(0);
    expect(payload.result.remoteProcessed).toBe(0);
    expect(payload.remaining).toBe(0);
    expect(payload.mapping).toBe("LIN-9000");
    expect(payload.displayId).toBe("LIN-9000");
    expect(payload.row?.linear_identifier).toBe("LIN-9000");
    expect(payload.row?.sync_status).toBe("synced");
  });

  test("allows create replay when an unresolved update row appears earlier in the queue", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "update_before_create");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      result: { success: number; failed: number; deferred: number; remoteProcessed: number };
      remaining: number;
      pending: Array<{
        id: number;
        operation: string;
        local_id: string | null;
        payload: { issueId?: string };
      }>;
      mapping: string | null;
      displayId: string;
      row: { local_id: string; linear_identifier: string | null; sync_status: string } | null;
    };

    expect(payload.result.success).toBe(1);
    expect(payload.result.failed).toBe(0);
    expect(payload.result.deferred).toBe(1);
    expect(payload.result.remoteProcessed).toBe(0);
    expect(payload.remaining).toBe(1);
    expect(payload.pending[0]?.operation).toBe("update");
    expect(payload.mapping).toBe("LIN-9003");
    expect(payload.displayId).toBe("LIN-9003");
    expect(payload.row?.linear_identifier).toBe("LIN-9003");
    expect(payload.row?.sync_status).toBe("synced");
  });

  test("self-heals orphaned LOCAL parent refs in queued create payloads", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "orphan_parent");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      result: { success: number; failed: number; deferred: number; remoteProcessed: number };
      remaining: number;
      pending: Array<{ id: number; operation: string; local_id: string | null; payload: unknown }>;
      mapping: string | null;
      displayId: string;
      row: { local_id: string; linear_identifier: string | null; sync_status: string } | null;
    };

    expect(payload.result.success).toBe(1);
    expect(payload.result.failed).toBe(0);
    expect(payload.result.deferred).toBe(0);
    expect(payload.result.remoteProcessed).toBe(0);
    expect(payload.remaining).toBe(0);
    expect(payload.mapping).toBe("LIN-9004");
    expect(payload.displayId).toBe("LIN-9004");
    expect(payload.row?.linear_identifier).toBe("LIN-9004");
    expect(payload.row?.sync_status).toBe("synced");
  });

  test("queues relation retry when create deps fail in background processing", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "deps_retry");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      result: { success: number; failed: number; deferred: number; remoteProcessed: number };
      remaining: number;
      pending: Array<{
        id: number;
        operation: string;
        local_id: string | null;
        payload: { issueId?: string; relatedIssueId?: string; type?: string };
      }>;
      mapping: string | null;
      displayId: string;
      row: { local_id: string; linear_identifier: string | null; sync_status: string } | null;
    };

    expect(payload.result.success).toBe(1);
    expect(payload.result.failed).toBe(0);
    expect(payload.result.remoteProcessed).toBe(0);
    expect(payload.remaining).toBe(1);
    expect(payload.pending[0]?.operation).toBe("create_relation");
    expect(payload.pending[0]?.payload?.type).toBe("blocks");
    expect(payload.pending[0]?.payload?.issueId).toBe("LIN-9999");
    expect(payload.pending[0]?.payload?.relatedIssueId).toBe("LIN-9005");
    expect(payload.mapping).toBe("LIN-9005");
    expect(payload.displayId).toBe("LIN-9005");
    expect(payload.row?.linear_identifier).toBe("LIN-9005");
    expect(payload.row?.sync_status).toBe("synced");
  });

  test("keeps relation retries on stable identifiers even when a Linear UUID is already cached", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "deps_retry_prefers_identifier");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      result: { success: number; failed: number; deferred: number; remoteProcessed: number };
      remaining: number;
      pending: Array<{
        id: number;
        operation: string;
        local_id: string | null;
        payload: { issueId?: string; relatedIssueId?: string; type?: string };
      }>;
      mapping: string | null;
      displayId: string;
      row: { local_id: string; linear_identifier: string | null; sync_status: string } | null;
      uuidResolution: { local_id: string; display_id: string } | null;
    };

    expect(payload.result.success).toBe(1);
    expect(payload.result.failed).toBe(0);
    expect(payload.remaining).toBe(1);
    expect(payload.pending[0]?.operation).toBe("create_relation");
    expect(payload.pending[0]?.payload?.issueId).toBe("LIN-9999");
    expect(payload.pending[0]?.payload?.relatedIssueId).toBe("LIN-9005");
    expect(payload.pending[0]?.payload?.relatedIssueId).not.toBe(
      "123e4567-e89b-12d3-a456-426614174000"
    );
    expect(payload.uuidResolution?.local_id).toBe(payload.row?.local_id);
    expect(payload.uuidResolution?.display_id).toBe("LIN-9005");
  });

  test("preserves alias LOCAL mappings when replacing duplicate LIN identifiers", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "alias_merge_resolution");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      result: { success: number; failed: number; deferred: number; remoteProcessed: number };
      remaining: number;
      pending: Array<{ id: number; operation: string; local_id: string | null; payload: unknown }>;
      mapping: string | null;
      displayId: string;
      row: { local_id: string; linear_identifier: string | null; sync_status: string } | null;
      alias: {
        local_id: string;
        mapping: string | null;
        resolved_remote_id: string;
        resolved_local_id: string;
      } | null;
    };

    expect(payload.result.success).toBeGreaterThanOrEqual(2);
    expect(payload.result.failed).toBe(0);
    expect(payload.mapping).toBe("LIN-9007");
    expect(payload.row?.linear_identifier).toBe("LIN-9007");
    expect(payload.alias).not.toBeNull();
    expect(payload.alias?.mapping).toBe("LIN-9007");
    expect(payload.alias?.resolved_remote_id).toBe("LIN-9007");
    expect(payload.alias?.resolved_local_id).toBe(payload.row?.local_id);
  }, 10000);

  test("drops legacy placeholder refs in create payloads and still finalizes mapping", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "legacy_placeholder_refs");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      result: { success: number; failed: number; deferred: number; remoteProcessed: number };
      remaining: number;
      pending: Array<{
        id: number;
        operation: string;
        local_id: string | null;
        payload: { issueId?: string; relatedIssueId?: string; type?: string };
      }>;
      mapping: string | null;
      displayId: string;
      row: { local_id: string; linear_identifier: string | null; sync_status: string } | null;
    };

    expect(payload.result.success).toBe(1);
    expect(payload.result.failed).toBe(0);
    expect(payload.result.deferred).toBe(0);
    expect(payload.result.remoteProcessed).toBe(0);
    expect(payload.remaining).toBe(0);
    expect(payload.pending).toEqual([]);
    expect(payload.mapping).toBe("LIN-9006");
    expect(payload.displayId).toBe("LIN-9006");
    expect(payload.row?.linear_identifier).toBe("LIN-9006");
    expect(payload.row?.sync_status).toBe("synced");
  });

  test("revives missing cached create rows from outbox payloads before finalizing mapping", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "missing_cached_issue_row");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      result: { success: number; failed: number; deferred: number; remoteProcessed: number };
      remaining: number;
      mapping: string | null;
      displayId: string;
      row: { local_id: string; linear_identifier: string | null; sync_status: string } | null;
    };

    expect(payload.result.success).toBe(1);
    expect(payload.result.failed).toBe(0);
    expect(payload.result.deferred).toBe(0);
    expect(payload.result.remoteProcessed).toBe(0);
    expect(payload.remaining).toBe(0);
    expect(payload.mapping).toBe("LIN-9014");
    expect(payload.displayId).toBe("LIN-9014");
    expect(payload.row?.linear_identifier).toBe("LIN-9014");
    expect(payload.row?.sync_status).toBe("synced");
  });

  test("does not let one deferred child block siblings that only share a resolved parent", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "shared_parent_resolution");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      pass1: { success: number; failed: number; deferred: number; remoteProcessed: number };
      pass2: { success: number; failed: number; deferred: number; remoteProcessed: number };
      pass3: { success: number; failed: number; deferred: number; remoteProcessed: number };
      pendingAfterPass1: Array<{ operation: string; local_id: string | null }>;
      pendingAfterPass2: Array<{ operation: string; local_id: string | null }>;
      pendingFinal: Array<{ operation: string; local_id: string | null }>;
      siblingLocalId: string;
      siblingDisplayId: string;
      siblingRow: {
        local_id: string;
        linear_identifier: string | null;
        sync_status: string;
      } | null;
    };

    expect(payload.pass1.success).toBe(3);
    expect(payload.pass1.failed).toBe(0);
    expect(payload.pass1.deferred).toBe(1);
    expect(payload.pendingAfterPass1).toHaveLength(1);
    expect(payload.pendingAfterPass1[0]?.local_id).not.toBe(payload.siblingLocalId);
    expect(payload.siblingDisplayId).toBe("LIN-9012");
    expect(payload.siblingRow?.linear_identifier).toBe("LIN-9012");
    expect(payload.siblingRow?.sync_status).toBe("synced");
    expect(payload.pass2.success).toBe(1);
    expect(payload.pass2.failed).toBe(0);
    expect(payload.pendingAfterPass2).toHaveLength(1);
    expect(payload.pendingAfterPass2[0]?.operation).toBe("create_relation");
    expect(payload.pass3.success).toBe(1);
    expect(payload.pass3.failed).toBe(0);
    expect(payload.pendingFinal).toHaveLength(0);
  }, 10000);

  test("defers queued LOCAL blocker relations until both create rows resolve", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "local_blocker_relation_replays_after_create_resolution");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      pass1: { success: number; failed: number; deferred: number; remoteProcessed: number };
      pass2: { success: number; failed: number; deferred: number; remoteProcessed: number };
      pendingAfterPass1: Array<{
        operation: string;
        local_id: string | null;
        payload: { issueId?: string; relatedIssueId?: string; type?: string };
      }>;
      pendingAfterPass2: Array<{
        operation: string;
        local_id: string | null;
        payload: { issueId?: string; relatedIssueId?: string; type?: string };
      }>;
      blockedDisplayId: string;
      blockerDisplayId: string;
      blockedMapping: string | null;
      blockerMapping: string | null;
    };

    expect(payload.pass1.success).toBe(2);
    expect(payload.pass1.failed).toBe(0);
    expect(payload.pass1.deferred).toBe(1);
    expect(payload.pendingAfterPass1).toHaveLength(1);
    expect(payload.pendingAfterPass1[0]?.operation).toBe("create_relation");
    expect(payload.pendingAfterPass1[0]?.payload?.issueId).toMatch(/^LOCAL-/);
    expect(payload.pendingAfterPass1[0]?.payload?.relatedIssueId).toMatch(/^LOCAL-/);
    expect(payload.blockedMapping).toBe("LIN-9015");
    expect(payload.blockerMapping).toBe("LIN-9016");
    expect(payload.blockedDisplayId).toBe("LIN-9015");
    expect(payload.blockerDisplayId).toBe("LIN-9016");
    expect(payload.pass2.success + payload.pass2.failed).toBe(1);
    expect(payload.pass2.deferred).toBe(0);
  });

  test("drops malformed parent and dependency refs from queued create payloads", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "invalid_issue_refs_are_dropped_from_create_payloads");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      result: { success: number; failed: number; deferred: number; remoteProcessed: number };
      pending: Array<{ operation: string; local_id: string | null; payload: unknown }>;
      depRows: Array<{ issue_id: string; depends_on_id: string; type: string }>;
      row: { local_id: string; linear_identifier: string | null; sync_status: string } | null;
      mapping: string | null;
    };

    expect(payload.result.success).toBe(1);
    expect(payload.result.failed).toBe(0);
    expect(payload.result.deferred).toBe(0);
    expect(payload.pending).toHaveLength(0);
    expect(payload.depRows).toEqual([]);
    expect(payload.mapping).toBe("LIN-9017");
    expect(payload.row?.linear_identifier).toBe("LIN-9017");
    expect(payload.row?.sync_status).toBe("synced");
  });

  test("auto-heals self-referential pending sync state while preserving real sibling blockers", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "self_referential_pending_sync_state");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      result: { success: number; failed: number };
      pending: Array<{
        operation: string;
        local_id: string | null;
        payload: Record<string, unknown>;
      }>;
      depRows: Array<{ issue_id: string; depends_on_id: string; type: string }>;
      row: { local_id: string; linear_identifier: string | null; sync_status: string } | null;
      mapping: string | null;
      displayId: string;
      siblingDisplayId: string;
    };

    expect(payload.result.failed).toBe(0);
    expect(payload.pending).toHaveLength(0);
    expect(payload.mapping).toBe("LIN-5617");
    expect(payload.displayId).toBe("LIN-5617");
    expect(payload.row?.linear_identifier).toBe("LIN-5617");
    expect(payload.row?.sync_status).toBe("synced");
    expect(payload.depRows.some((row) => row.issue_id === row.depends_on_id)).toBe(false);
    expect(payload.depRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "blocks",
        }),
      ])
    );
    expect(payload.siblingDisplayId).toBe("LIN-5616");
    expect(
      payload.depRows.some((row) => row.type === "blocks" && row.issue_id !== row.depends_on_id)
    ).toBe(true);
  });

  test("show and dep tree stop surfacing fake self-block output after healing", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "self_referential_pending_sync_state");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      displayId: string;
      localId: string;
    };

    const shown = await runCli(repoDir, "show", payload.localId);
    expect(shown.exitCode).toBe(0);
    expect(shown.stderr).toBe("");
    expect(shown.stdout).toContain(payload.displayId);
    expect(shown.stdout).toContain("LIN-5616");
    expect(shown.stdout).not.toContain(`${payload.displayId} (circular)`);

    const tree = await runCli(repoDir, "dep", "tree", payload.localId);
    expect(tree.exitCode).toBe(0);
    expect(tree.stderr).toBe("");
    expect(tree.stdout).toContain(payload.displayId);
    expect(tree.stdout).not.toContain("(circular)");
  });
});
