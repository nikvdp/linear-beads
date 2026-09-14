import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = join(import.meta.dir, "..");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function runScenario(
  script: string,
  config: Record<string, unknown> = { local_only: true },
  expectedError?: string
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "lb-workflow-states-"));
  tempDirs.push(cwd);
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd });
  expect(init.exitCode).toBe(0);
  mkdirSync(join(cwd, ".lb"));
  writeFileSync(join(cwd, ".lb", "config.jsonc"), JSON.stringify(config));
  const proc = Bun.spawn(
    [
      "bun",
      "--eval",
      `import assert from "node:assert/strict";
       import * as db from ${JSON.stringify(join(root, "src/utils/database.ts"))};
       import { updateCommand } from ${JSON.stringify(join(root, "src/commands/update.ts"))};
       import { writePidFile } from ${JSON.stringify(join(root, "src/utils/pid-manager.ts"))};
       import { recordRemoteSyncPause } from ${JSON.stringify(join(root, "src/utils/remote-sync-state.ts"))};
       import { getRepoLabel } from ${JSON.stringify(join(root, "src/utils/config.ts"))};
       import { processOutboxQueue } from ${JSON.stringify(join(root, "src/utils/outbox-processor.ts"))};
       writePidFile(process.pid);
       async function update(status) {
         const log = console.log;
         console.log = () => {};
         try {
           await updateCommand.parseAsync(["LIN-9000", "--status", status, "--json"], { from: "user" });
         } finally {
           console.log = log;
         }
       }
       import * as linear from ${JSON.stringify(join(root, "src/utils/linear.ts"))};
       const now = "2026-09-14T00:00:00.000Z";
       const issue = { id: "LIN-9000", title: "Workflow test", status: "open", priority: 2, created_at: now, updated_at: now };
       ${script}
       db.closeDatabase();`,
    ],
    {
      cwd,
      env: {
        ...process.env,
        HOME: cwd,
        LB_TEAM_KEY: "LIN",
        LB_TEAM_ID: "",
        LINEAR_API_KEY: "",
        LB_LOCAL_ONLY: "",
        LB_LINEAR_MAX_RETRIES: "1",
        LB_LINEAR_RETRY_BASE_MS: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (expectedError) {
    expect(exitCode).toBe(1);
    expect(stderr).toContain(expectedError);
  } else {
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  }
}

test("custom workflow filters survive cache writes and schema upgrades", async () => {
  await runScenario(`
    const database = db.getDatabase();
    if (database.query("PRAGMA table_info(issues)").all().some(c => c.name === "linear_state_name")) {
      database.exec("ALTER TABLE issues DROP COLUMN linear_state_name");
    }
    database.exec("PRAGMA user_version = 14");
    db.closeDatabase();
    db.cacheIssue({ ...issue, status: "in_progress", linear_state_name: "In Review" });
    db.closeDatabase();
    assert.equal(db.getCachedIssue(issue.id).linear_state_name, "In Review");
    const result = Bun.spawnSync(["bun", ${JSON.stringify(join(root, "src/cli.ts"))}, "list", "--all", "--status", "In Review", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.deepEqual(JSON.parse(result.stdout.toString()).map(i => i.id), [issue.id]);
    db.cacheIssues([{ ...issue, status: "closed", linear_state_name: "Done" }]);
    assert.equal(db.getCachedIssues()[0].linear_state_name, "Done");
  `);
});

const remoteConfig = { local_only: false, api_key: "test-key", team_key: "LIN" };

test("cached custom updates keep canonical status and terminal metadata without network access", async () => {
  await runScenario(
    `
    db.cacheIssue(issue);
    db.cacheTeamId("LIN", "team-1");
    db.cacheWorkflowStates("team-1", [
      { id: "review", name: "In Review", type: "started" },
      { id: "done", name: "Done", type: "completed" }
    ]);
    globalThis.fetch = () => { throw new Error("Unexpected network request"); };
    await update("Done");
    const done = db.getCachedIssue(issue.id);
    assert.equal(done.status, "closed");
    assert.equal(done.linear_state_name, "Done");
    assert.ok(done.closed_at);
    await update("in review");
    const review = db.getCachedIssue(issue.id);
    assert.equal(review.status, "in_progress");
    assert.equal(review.linear_state_name, "In Review");
    assert.ok(!review.closed_at);
    assert.equal(db.getPendingOutboxItems().at(-1).payload.status, "in review");
  `,
    remoteConfig
  );
});

test("paused unknown workflows queue without changing the last known canonical state", async () => {
  await runScenario(
    `
    db.cacheIssue({ ...issue, status: "closed", linear_state_name: "Done", closed_at: now });
    recordRemoteSyncPause(new Error("network unavailable"));
    globalThis.fetch = () => { throw new Error("Unexpected network request"); };
    await update("New Review");
    const cached = db.getCachedIssue(issue.id);
    assert.equal(cached.status, "closed");
    assert.equal(cached.linear_state_name, "Done");
    assert.equal(cached.closed_at, now);
    assert.equal(db.getPendingOutboxItems()[0].payload.status, "New Review");
  `,
    remoteConfig
  );
});

test("network failure during custom status validation defers validation to the outbox", async () => {
  await runScenario(
    `
    db.cacheIssue(issue);
    globalThis.fetch = () => { throw new Error("fetch failed: ECONNREFUSED"); };
    await update("In Review");
    assert.equal(db.getCachedIssue(issue.id).status, "open");
    assert.equal(db.getPendingOutboxItems()[0].payload.status, "In Review");
  `,
    remoteConfig
  );
});

test("custom status sync propagates canonical transitions to the parent", async () => {
  await runScenario(
    `
    const states = [
      { id: "todo", name: "Todo", type: "unstarted" },
      { id: "review", name: "In Review", type: "started" },
      { id: "done", name: "Done", type: "completed" }
    ];
    db.cacheWorkflowStates("team-1", states);
    db.cacheIssue(issue);
    db.cacheIssue({ ...issue, id: "LIN-9001", title: "Parent" });
    db.cacheDependency({ issue_id: issue.id, depends_on_id: "LIN-9001", type: "parent-child", created_at: now, created_by: "test" });
    globalThis.fetch = async (_url, init) => {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes("GetIssueDescriptionForHeal")) {
        return Response.json({ data: { issue: { description: null } } });
      }
      assert.ok(query.includes("mutation UpdateIssue"), query);
      const state = states.find(s => s.id === variables.input.stateId);
      assert.ok(state);
      return Response.json({ data: { issueUpdate: { success: true, issue: {
        id: variables.id, identifier: variables.id, title: "Workflow test",
        state, priority: 2, createdAt: now, updatedAt: now,
        completedAt: state.type === "completed" ? now : null,
        labels: { nodes: [] }, assignee: null, parent: null
      } } } });
    };
    db.queueOutboxItem("update", { issueId: issue.id, status: "In Review" }, issue.id);
    assert.equal((await processOutboxQueue("team-1", { propagateParent: true })).failed, 0);
    assert.equal(db.getCachedIssue("LIN-9001").status, "in_progress");
    db.queueOutboxItem("update", { issueId: issue.id, status: "Done" }, issue.id);
    assert.equal((await processOutboxQueue("team-1", { propagateParent: true })).failed, 0);
    assert.equal(db.getCachedIssue("LIN-9001").status, "open");
  `,
    remoteConfig
  );
});

test("online validation still rejects nonexistent workflow names", async () => {
  await runScenario(
    `
    db.cacheIssue(issue);
    globalThis.fetch = async (_url, init) => {
      const { query } = JSON.parse(init.body);
      if (query.includes("GetTeam")) {
        return Response.json({ data: { teams: { nodes: [{ id: "team-1", key: "LIN" }] } } });
      }
      assert.ok(query.includes("GetWorkflowStates"), query);
      return Response.json({ data: { team: { states: { nodes: [{ id: "todo", name: "Todo", type: "unstarted" }] } } } });
    };
    await update("Typo");
  `,
    remoteConfig,
    "Invalid status 'Typo'. Available states: Todo"
  );
});

test("canonical terminal commands clear previous custom workflow names", async () => {
  await runScenario(`
    for (const args of [["close"], ["cancel"], ["update", "--status", "closed"]]) {
      db.cacheIssue({ ...issue, status: "in_progress", linear_state_name: "In Review" });
      const result = Bun.spawnSync(["bun", ${JSON.stringify(join(root, "src/cli.ts"))}, args[0], issue.id, ...args.slice(1), "--json"]);
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.equal(db.getCachedIssue(issue.id).linear_state_name, undefined);
    }
  `);
});

test("creation refreshes rejected workflow states once and surfaces persistent failures", async () => {
  for (const persistentFailure of [false, true]) {
    await runScenario(
      `
      const state = { id: "new-state", name: "Todo", type: "unstarted" };
      db.cacheWorkflowStates("team-1", [{ ...state, id: "deleted-state" }]);
      db.cacheLabel("11111111-1111-4111-8111-111111111111", getRepoLabel(), "team-1");
      let mutations = 0;
      let refreshes = 0;
      const staleError = Object.assign(new Error("Entity not found: WorkflowState"), {
        response: { errors: [{
          message: "Entity not found: WorkflowState",
          path: ["issueCreate"],
          extensions: { type: "EntityNotFound", code: "INPUT_ERROR" }
        }] }
      });
      const client = { async request(query, variables) {
        if (query.includes("GetWorkflowStates")) {
          refreshes++;
          return { team: { states: { nodes: [state] } } };
        }
        assert.ok(query.includes("mutation CreateIssue"), query);
        mutations++;
        if (variables.input.stateId === "deleted-state" || ${persistentFailure}) throw staleError;
        assert.equal(variables.input.stateId, state.id);
        return { issueCreate: { success: true, issue: {
          id: "new-issue", identifier: issue.id, title: issue.title, state,
          priority: 2, createdAt: now, updatedAt: now, labels: { nodes: [] }
        } } };
      } };
      const creation = linear.createIssue({ title: issue.title, priority: 2, teamId: "team-1", client });
      if (${persistentFailure}) {
        await assert.rejects(creation, error => error === staleError);
      } else {
        const created = await creation;
        assert.equal(created.status, "open");
        assert.equal(db.getCachedIssue(created.id).linear_state_name, "Todo");
      }
      assert.equal(mutations, 2);
      assert.equal(refreshes, 1);
    `,
      { ...remoteConfig, repo_scope: "label" }
    );
  }
});
