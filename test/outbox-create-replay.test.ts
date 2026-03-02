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
  mode: "mapping" | "marker"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import {
      cacheIssue,
      generateLocalId,
      getDisplayId,
      getIssueIdMapping,
      getPendingOutboxItems,
      markOutboxCreateRemoteIssueIdentifier,
      queueOutboxItem,
      setIssueIdMapping,
    } from ${JSON.stringify(DATABASE_UTILS_PATH)};
    import { processOutboxQueue } from ${JSON.stringify(OUTBOX_PROCESSOR_PATH)};

    const now = new Date().toISOString();
    const localId = generateLocalId();
    cacheIssue({
      id: localId,
      title: "Replay guard issue",
      status: "open",
      priority: 2,
      sync_status: "pending",
      created_at: now,
      updated_at: now,
    });

    const outboxId = queueOutboxItem("create", { title: "Replay guard issue", priority: 2 }, localId);
    const mode = process.argv[1];
    if (mode === "mapping") {
      setIssueIdMapping(localId, "LIN-9001");
    } else if (mode === "marker") {
      markOutboxCreateRemoteIssueIdentifier(outboxId, "LIN-9002");
    }

    const result = await processOutboxQueue("TEAM");
    const remaining = getPendingOutboxItems().length;
    const mapping = getIssueIdMapping(localId);
    const displayId = getDisplayId(localId);
    console.log(JSON.stringify({ result, remaining, mapping, displayId }));
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
      mapping: string | null;
      displayId: string;
    };
    expect(payload.result.success).toBe(1);
    expect(payload.result.failed).toBe(0);
    expect(payload.remaining).toBe(0);
    expect(payload.mapping).toBe("LIN-9001");
    expect(payload.displayId).toBe("LIN-9001");
  });

  test("uses persisted outbox remote marker to finalize mapping without re-create", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "marker");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      result: { success: number; failed: number };
      remaining: number;
      mapping: string | null;
      displayId: string;
    };
    expect(payload.result.success).toBe(1);
    expect(payload.result.failed).toBe(0);
    expect(payload.remaining).toBe(0);
    expect(payload.mapping).toBe("LIN-9002");
    expect(payload.displayId).toBe("LIN-9002");
  });
});
