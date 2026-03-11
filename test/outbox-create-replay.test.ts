import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tempDirs: string[] = [];
const DATABASE_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "database.ts");
const OUTBOX_PROCESSOR_PATH = join(import.meta.dir, "..", "src", "utils", "outbox-processor.ts");

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
    | "alias_merge_resolution"
    | "shared_parent_resolution"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import { Database } from "bun:sqlite";
    import {
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
      const db = new Database(".lb/cache.db");
      db.run("UPDATE issues SET linear_id = ? WHERE local_id = ?", ["uuid-9005", localId]);
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
          parentId: "undefined",
          deps: "blocked-by:undefined,related:null,blocks:LIN-9006",
        },
        localId
      );
      markOutboxCreateRemoteIssueIdentifier(outboxId, "LIN-9006");
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
          pendingAfterPass1,
          pendingFinal,
          siblingLocalId,
          siblingDisplayId: getDisplayId(siblingLocalId),
          siblingRow,
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
          local_id: resolveIssueLocalId("uuid-9005"),
          display_id: getDisplayId("uuid-9005"),
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

  test("drops orphaned create outbox rows when local issue no longer exists", async () => {
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
    expect(payload.mapping).toBeNull();
    expect(payload.displayId).toMatch(/^LOCAL-/);
    expect(payload.row).toBeNull();
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
    expect(payload.pending[0]?.payload?.relatedIssueId).not.toBe("uuid-9005");
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
  });

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
    expect(payload.remaining).toBe(1);
    expect(payload.pending[0]?.operation).toBe("create_relation");
    expect(payload.pending[0]?.payload?.type).toBe("blocks");
    expect(payload.pending[0]?.payload?.issueId).toBe("LIN-9006");
    expect(payload.pending[0]?.payload?.relatedIssueId).toBe("LIN-9006");
    expect(payload.mapping).toBe("LIN-9006");
    expect(payload.displayId).toBe("LIN-9006");
    expect(payload.row?.linear_identifier).toBe("LIN-9006");
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
      pendingAfterPass1: Array<{ operation: string; local_id: string | null }>;
      pendingFinal: Array<{ operation: string; local_id: string | null }>;
      siblingLocalId: string;
      siblingDisplayId: string;
      siblingRow: { local_id: string; linear_identifier: string | null; sync_status: string } | null;
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
    expect(payload.pendingFinal).toHaveLength(0);
  });
});
