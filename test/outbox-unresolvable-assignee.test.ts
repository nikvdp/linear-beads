import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const DATABASE_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "database.ts");
const OUTBOX_PROCESSOR_PATH = join(import.meta.dir, "..", "src", "utils", "outbox-processor.ts");
const REMOTE_SYNC_STATE_PATH = join(import.meta.dir, "..", "src", "utils", "remote-sync-state.ts");

const tempDirs: string[] = [];

setDefaultTimeout(15000);

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): { repoDir: string; dbPath: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-outbox-assignee-"));
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

async function runEval(
  cwd: string,
  setupSource: string,
  envOverrides: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import { clearRemoteSyncPause } from ${JSON.stringify(REMOTE_SYNC_STATE_PATH)};
    clearRemoteSyncPause();
    ${setupSource}
    process.exit(0);
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

async function runInlineCli(
  cwd: string,
  args: string[],
  setupSource: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import { clearRemoteSyncPause } from ${JSON.stringify(REMOTE_SYNC_STATE_PATH)};
    clearRemoteSyncPause();
    ${setupSource}
    process.argv = ["bun", ${args.map((arg) => JSON.stringify(arg)).join(", ")}];
    await import(${JSON.stringify(CLI_PATH)});
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
  return { stdout, stderr, exitCode };
}

const FETCH_MOCK_PRELUDE = `
  const linearIssue = (id, identifier) => ({
    id,
    identifier,
    title: "Replay guard issue",
    description: "",
    priority: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    canceledAt: null,
    state: { id: "state-open", name: "Open", type: "unstarted" },
    labels: { nodes: [] },
    assignee: null,
    creator: null,
    parent: null,
  });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.query.includes("query GetUser")) {
      const email = body.variables?.email || "";
      const nodes = email === "lily@metrograph.ai"
        ? [{ id: "USER-LILY", email: "lily@metrograph.ai", name: "Lily" }]
        : [];
      return new Response(
        JSON.stringify({ data: { users: { nodes } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (body.query.includes("query Viewer")) {
      return new Response(
        JSON.stringify({ data: { viewer: { id: "USER-SYLVIE", email: "sylvie@metrograph.ai", name: "Sylvie" } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (body.query.includes("mutation UpdateIssue")) {
      return new Response(
        JSON.stringify({ data: { issueUpdate: { success: true, issue: linearIssue("uuid-upd", "LIN-1507") } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error("Unexpected query: " + body.query.slice(0, 120));
  };
`;

const QUEUE_UPDATE_SETUP = (assign: string, issueIdVar = "localId") => `
  import {
    cacheIssue,
    cacheViewer,
    generateLocalId,
    getOutboxDiagnosticItems,
    getPendingOutboxItems,
    queueOutboxItem,
    setIssueIdMapping,
  } from ${JSON.stringify(DATABASE_UTILS_PATH)};
  import { processOutboxQueue } from ${JSON.stringify(OUTBOX_PROCESSOR_PATH)};

  cacheViewer({ id: "USER-SYLVIE", email: "sylvie@metrograph.ai", name: "Sylvie" });
  const localId = generateLocalId();
  const now = new Date().toISOString();
  cacheIssue({
    id: localId,
    title: "Assignee test issue",
    status: "open",
    priority: 2,
    sync_status: "pending",
    created_at: now,
    updated_at: now,
  });
  setIssueIdMapping(localId, "LIN-1507");
  queueOutboxItem("update", { issueId: localId, assign: ${JSON.stringify(assign)}, description: "unchanged" }, localId);
  ${FETCH_MOCK_PRELUDE}
  const result = await processOutboxQueue("TEAM");
  const remaining = getPendingOutboxItems().map((item) => ({
    id: item.id,
    operation: item.operation,
    last_error: item.last_error || null,
    retry_count: item.retry_count,
  }));
  console.log(JSON.stringify({ result, remaining, issueId: ${issueIdVar} }));
`;

describe("outbox unresolvable assignee (MG-1665)", () => {
  test("bare handle resolves via viewer domain and pushes", async () => {
    const { repoDir } = createRepo();
    const result = await runEval(repoDir, QUEUE_UPDATE_SETUP("lily"));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout);
    expect(payload.result.success).toBe(1);
    expect(payload.result.failed).toBe(0);
    expect(payload.result.dropped).toBe(0);
    expect(payload.remaining).toEqual([]);
  });

  test("bare handle Linear cannot resolve is dropped, not retried", async () => {
    const { repoDir } = createRepo();
    const result = await runEval(repoDir, QUEUE_UPDATE_SETUP("ghost-user"));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout);
    expect(payload.result.success).toBe(0);
    expect(payload.result.failed).toBe(0);
    expect(payload.result.dropped).toBe(1);
    expect(payload.remaining).toEqual([]);
  });

  test("email assign resolves directly", async () => {
    const { repoDir } = createRepo();
    const result = await runEval(repoDir, QUEUE_UPDATE_SETUP("lily@metrograph.ai"));

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.result.success).toBe(1);
    expect(payload.result.dropped).toBe(0);
    expect(payload.remaining).toEqual([]);
  });

  test("network failure during resolution keeps the row retryable", async () => {
    const { repoDir } = createRepo();
    const setup = `
      import {
        cacheIssue,
        cacheViewer,
        generateLocalId,
        getOutboxDiagnosticItems,
        getOutboxRowCount,
        queueOutboxItem,
        setIssueIdMapping,
      } from ${JSON.stringify(DATABASE_UTILS_PATH)};
      import { processOutboxQueue } from ${JSON.stringify(OUTBOX_PROCESSOR_PATH)};

      cacheViewer({ id: "USER-SYLVIE", email: "sylvie@metrograph.ai", name: "Sylvie" });
      const localId = generateLocalId();
      const now = new Date().toISOString();
      cacheIssue({
        id: localId,
        title: "Assignee test issue",
        status: "open",
        priority: 2,
        sync_status: "pending",
        created_at: now,
        updated_at: now,
      });
      setIssueIdMapping(localId, "LIN-1507");
      queueOutboxItem("update", { issueId: localId, assign: "lily", description: "unchanged" }, localId);
      globalThis.fetch = async () => {
        throw new Error("fetch failed");
      };
      const result = await processOutboxQueue("TEAM");
      const remaining = getOutboxDiagnosticItems().map((item) => ({
        last_error: item.last_error || null,
        retry_count: item.retry_count,
      }));
      const rowCount = getOutboxRowCount({});
      console.log(JSON.stringify({ result, remaining, rowCount }));
    `;
    const result = await runEval(repoDir, setup);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.result.success).toBe(0);
    expect(payload.result.failed).toBe(1);
    expect(payload.result.dropped).toBe(0);
    expect(payload.rowCount).toBe(1);
    expect(payload.remaining.length).toBe(1);
    expect(payload.remaining[0].retry_count).toBeGreaterThan(0);
    expect(payload.remaining[0].last_error).toContain("fetch failed");
  });

  test("outbox purge deletes failed rows; reset-retry clears counters but keeps rows", async () => {
    const { repoDir } = createRepo();
    const setup = `
      import {
        generateLocalId,
        getOutboxDiagnosticItems,
        getOutboxRowCount,
        purgeOutboxItems,
        queueOutboxItem,
        resetOutboxRetryCounts,
        updateOutboxItemError,
      } from ${JSON.stringify(DATABASE_UTILS_PATH)};

      const purgeA = generateLocalId();
      const purgeB = generateLocalId();
      updateOutboxItemError(queueOutboxItem("update", { issueId: purgeA, assign: "ghost" }, purgeA), "User not found: ghost");
      updateOutboxItemError(queueOutboxItem("update", { issueId: purgeB, assign: "ghost" }, purgeB), "User not found: ghost");
      const failedBeforePurge = getOutboxRowCount({ failedOnly: true });
      const purged = purgeOutboxItems({ failedOnly: true });
      const remainingAfterPurge = getOutboxRowCount({});

      const resetA = generateLocalId();
      const resetB = generateLocalId();
      updateOutboxItemError(queueOutboxItem("update", { issueId: resetA, assign: "ghost" }, resetA), "User not found: ghost");
      updateOutboxItemError(queueOutboxItem("update", { issueId: resetB, assign: "ghost" }, resetB), "User not found: ghost");
      const reset = resetOutboxRetryCounts({ failedOnly: true });
      const afterReset = getOutboxDiagnosticItems().map((item) => ({
        retry_count: item.retry_count,
        last_error: item.last_error || null,
      }));
      const remainingAfterReset = getOutboxRowCount({});

      const scoped = generateLocalId();
      updateOutboxItemError(queueOutboxItem("update", { issueId: scoped, assign: "ghost" }, scoped), "User not found: ghost");
      const scopedRemoved = purgeOutboxItems({ failedOnly: true, issueId: scoped });
      const remainingAfterScoped = getOutboxRowCount({});

      console.log(JSON.stringify({
        failedBeforePurge,
        purged,
        remainingAfterPurge,
        reset,
        afterReset,
        remainingAfterReset,
        scopedRemoved,
        remainingAfterScoped,
      }));
    `;
    const result = await runEval(repoDir, setup);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.failedBeforePurge).toBe(2);
    expect(payload.purged).toBe(2);
    expect(payload.remainingAfterPurge).toBe(0);
    expect(payload.reset).toBe(2);
    expect(payload.afterReset).toEqual([
      { retry_count: 0, last_error: null },
      { retry_count: 0, last_error: null },
    ]);
    expect(payload.remainingAfterReset).toBe(2);
    expect(payload.scopedRemoved).toBe(1);
    expect(payload.remainingAfterScoped).toBe(2);
  });

  test("lb linear outbox exposes purge and reset-retry in help", async () => {
    const { repoDir } = createRepo();
    const result = await runInlineCli(repoDir, ["linear", "outbox", "--help"], "");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("purge");
    expect(result.stdout).toContain("reset-retry");
  });

  test("lb linear outbox purge --yes deletes failed rows via CLI", async () => {
    const { repoDir } = createRepo();
    const setup = `
      import {
        generateLocalId,
        queueOutboxItem,
        updateOutboxItemError,
      } from ${JSON.stringify(DATABASE_UTILS_PATH)};

      const localId = generateLocalId();
      const id = queueOutboxItem("update", { issueId: localId, assign: "ghost" }, localId);
      updateOutboxItemError(id, "User not found: ghost");
    `;
    const result = await runInlineCli(
      repoDir,
      ["linear", "outbox", "purge", "--yes", "--json"],
      setup
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.purged).toBe(1);
    expect(payload.matched).toBe(1);
  });

  test("lb linear outbox purge preview requires --yes", async () => {
    const { repoDir } = createRepo();
    const setup = `
      import {
        generateLocalId,
        queueOutboxItem,
        updateOutboxItemError,
      } from ${JSON.stringify(DATABASE_UTILS_PATH)};

      const localId = generateLocalId();
      const id = queueOutboxItem("update", { issueId: localId, assign: "ghost" }, localId);
      updateOutboxItemError(id, "User not found: ghost");
    `;
    const result = await runInlineCli(repoDir, ["linear", "outbox", "purge"], setup);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Would purge 1 outbox row(s)");
  });
});
