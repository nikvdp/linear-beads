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
  const repoDir = mkdtempSync(join(tmpdir(), "lb-outbox-repair-"));
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
  mode: "single" | "two_machine" | "future_retry"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import { Database } from "bun:sqlite";
    import {
      cacheIssue,
      generateLocalId,
      getDisplayId,
      getIssueIdMapping,
      getPendingOutboxItems,
      markOutboxCreateRemoteIssueIdentifier,
      repairCreateOutboxForUnsyncedIssues,
      queueMissingCreateOutboxItems,
      queueOutboxItem,
    } from ${JSON.stringify(DATABASE_UTILS_PATH)};
    import { processOutboxQueue } from ${JSON.stringify(OUTBOX_PROCESSOR_PATH)};

    const mode = process.argv[1];
    const now = new Date().toISOString();

    if (mode === "single") {
      const localId = generateLocalId();
      cacheIssue({
        id: localId,
        title: "Recovered orphan local issue",
        status: "open",
        priority: 2,
        sync_status: "pending",
        created_at: now,
        updated_at: now,
      });

      const repaired = queueMissingCreateOutboxItems();
      const repairedOutbox = getPendingOutboxItems().find(
        (item) => item.operation === "create" && item.local_id === localId
      );
      if (!repairedOutbox) {
        throw new Error("Expected repaired create outbox row");
      }
      markOutboxCreateRemoteIssueIdentifier(repairedOutbox.id, "LIN-9101");

      const result = await processOutboxQueue("TEAM");
      const pending = getPendingOutboxItems();
      const mapping = getIssueIdMapping(localId);
      const displayId = getDisplayId(localId);
      const db = new Database(".lb/cache.db", { readonly: true });
      const row = db.query(
        "SELECT local_id, linear_identifier, sync_status, sync_key FROM issues WHERE local_id = ? LIMIT 1"
      ).get(localId) as {
        local_id: string;
        linear_identifier: string | null;
        sync_status: string;
        sync_key: string | null;
      } | null;
      db.close();

      console.log(JSON.stringify({ repaired, result, pending: pending.length, mapping, displayId, row }));
      process.exit(0);
    }

    if (mode === "future_retry") {
      const localId = generateLocalId();
      cacheIssue({
        id: localId,
        title: "Retry-delayed create should be revived",
        status: "open",
        priority: 2,
        sync_status: "pending",
        created_at: now,
        updated_at: now,
      });

      const outboxId = queueOutboxItem(
        "create",
        { title: "Retry-delayed create should be revived", priority: 2 },
        localId
      );
      markOutboxCreateRemoteIssueIdentifier(outboxId, "LIN-9104");

      const db = new Database(".lb/cache.db");
      db.run(
        "UPDATE outbox SET next_attempt_at = ?, processing = 1, processing_started_at = ? WHERE id = ?",
        [new Date(Date.now() + 3600_000).toISOString(), now, outboxId]
      );
      db.run("UPDATE issues SET linear_identifier = '' WHERE local_id = ?", [localId]);
      db.close();

      const repaired = repairCreateOutboxForUnsyncedIssues();
      const pass1 = await processOutboxQueue("TEAM");
      const pass2 = await processOutboxQueue("TEAM");
      const pending = getPendingOutboxItems();
      const mapping = getIssueIdMapping(localId);
      const displayId = getDisplayId(localId);
      const verifyDb = new Database(".lb/cache.db", { readonly: true });
      const row = verifyDb.query(
        "SELECT local_id, linear_identifier, sync_status FROM issues WHERE local_id = ? LIMIT 1"
      ).get(localId) as {
        local_id: string;
        linear_identifier: string | null;
        sync_status: string;
      } | null;
      verifyDb.close();

      console.log(JSON.stringify({ repaired, pass1, pass2, pending: pending.length, mapping, displayId, row }));
      process.exit(0);
    }

    const parentLocalId = generateLocalId();
    const childLocalId = generateLocalId();
    cacheIssue({
      id: parentLocalId,
      title: "Parent missing create outbox",
      status: "open",
      priority: 2,
      sync_status: "pending",
      created_at: now,
      updated_at: now,
    });
    cacheIssue({
      id: childLocalId,
      title: "Child already queued",
      status: "open",
      priority: 2,
      sync_status: "pending",
      created_at: now,
      updated_at: now,
    });

    // Simulate machine-B state where child create exists but parent create row is missing.
    const childOutboxId = queueOutboxItem(
      "create",
      { title: "Child already queued", priority: 2, parentId: parentLocalId },
      childLocalId
    );
    markOutboxCreateRemoteIssueIdentifier(childOutboxId, "LIN-9103");

    const repaired = queueMissingCreateOutboxItems();
    const pendingAfterRepair = getPendingOutboxItems();
    const parentOutbox = pendingAfterRepair.find(
      (item) => item.operation === "create" && item.local_id === parentLocalId
    );
    if (!parentOutbox) {
      throw new Error("Expected repaired parent create outbox row");
    }
    markOutboxCreateRemoteIssueIdentifier(parentOutbox.id, "LIN-9102");

    // First pass may defer child until parent is mapped.
    const pass1 = await processOutboxQueue("TEAM");
    const pass2 = await processOutboxQueue("TEAM");
    const pendingFinal = getPendingOutboxItems();

    const parentMapping = getIssueIdMapping(parentLocalId);
    const childMapping = getIssueIdMapping(childLocalId);
    const parentDisplayId = getDisplayId(parentLocalId);
    const childDisplayId = getDisplayId(childLocalId);

    const db = new Database(".lb/cache.db", { readonly: true });
    const parentRow = db.query(
      "SELECT local_id, linear_identifier, sync_status, sync_key FROM issues WHERE local_id = ? LIMIT 1"
    ).get(parentLocalId) as {
      local_id: string;
      linear_identifier: string | null;
      sync_status: string;
      sync_key: string | null;
    } | null;
    const childRow = db.query(
      "SELECT local_id, linear_identifier, sync_status, sync_key FROM issues WHERE local_id = ? LIMIT 1"
    ).get(childLocalId) as {
      local_id: string;
      linear_identifier: string | null;
      sync_status: string;
      sync_key: string | null;
    } | null;
    db.close();

    console.log(
      JSON.stringify({
        repaired,
        pass1,
        pass2,
        pendingFinal: pendingFinal.length,
        parentMapping,
        childMapping,
        parentDisplayId,
        childDisplayId,
        parentRow,
        childRow,
      })
    );
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

describe("missing create outbox repair", () => {
  test("repairs a single local issue and converges to LIN mapping", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "single");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      repaired: number;
      result: { success: number; failed: number; deferred: number };
      pending: number;
      mapping: string | null;
      displayId: string;
      row: {
        local_id: string;
        linear_identifier: string | null;
        sync_status: string;
        sync_key: string | null;
      } | null;
    };

    expect(payload.repaired).toBe(1);
    expect(payload.result.success).toBe(1);
    expect(payload.result.failed).toBe(0);
    expect(payload.pending).toBe(0);
    expect(payload.mapping).toBe("LIN-9101");
    expect(payload.displayId).toBe("LIN-9101");
    expect(payload.row?.sync_status).toBe("synced");
    expect(payload.row?.sync_key).toBeTruthy();
  });

  test("repairs missing parent create row in a two-machine style queue state", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "two_machine");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      repaired: number;
      pass1: { success: number; failed: number; deferred: number };
      pass2: { success: number; failed: number; deferred: number };
      pendingFinal: number;
      parentMapping: string | null;
      childMapping: string | null;
      parentDisplayId: string;
      childDisplayId: string;
      parentRow: { sync_status: string; sync_key: string | null } | null;
      childRow: { sync_status: string; sync_key: string | null } | null;
    };

    expect(payload.repaired).toBe(1);
    expect(payload.pass1.failed).toBe(0);
    expect(payload.pass2.failed).toBe(0);
    expect(payload.pendingFinal).toBe(0);
    expect(payload.parentMapping).toBe("LIN-9102");
    expect(payload.childMapping).toBe("LIN-9103");
    expect(payload.parentDisplayId).toBe("LIN-9102");
    expect(payload.childDisplayId).toBe("LIN-9103");
    expect(payload.parentRow?.sync_status).toBe("synced");
    expect(payload.childRow?.sync_status).toBe("synced");
    expect(payload.parentRow?.sync_key).toBeTruthy();
    expect(payload.childRow?.sync_key).toBeTruthy();
  });

  test("revives delayed/stuck create rows and treats blank linear_identifier as unresolved", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "future_retry");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      repaired: { queued: number; revived: number };
      pass1: { success: number; failed: number; deferred: number };
      pass2: { success: number; failed: number; deferred: number };
      pending: number;
      mapping: string | null;
      displayId: string;
      row: { linear_identifier: string | null; sync_status: string } | null;
    };

    expect(payload.repaired.queued).toBe(0);
    expect(payload.repaired.revived).toBeGreaterThan(0);
    expect(payload.pass1.failed).toBe(0);
    expect(payload.pass2.failed).toBe(0);
    expect(payload.pending).toBe(0);
    expect(payload.mapping).toBe("LIN-9104");
    expect(payload.displayId).toBe("LIN-9104");
    expect(payload.row?.linear_identifier).toBe("LIN-9104");
    expect(payload.row?.sync_status).toBe("synced");
  });
});
