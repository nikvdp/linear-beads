import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isProcessAlive,
  parseElapsedSeconds,
  parseWorkerProcessTable,
  reapZombieWorkerProcesses,
  type WorkerProcessInfo,
} from "../src/utils/pid-manager.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(name: string, pid?: number): string {
  const repoDir = mkdtempSync(join(tmpdir(), `lb-${name}-`));
  tempDirs.push(repoDir);
  mkdirSync(join(repoDir, ".lb"), { recursive: true });
  if (typeof pid === "number") {
    writeFileSync(join(repoDir, ".lb", "sync.pid"), `${pid}\n`);
  }
  return repoDir;
}

describe("pid manager worker inspection", () => {
  test("parseElapsedSeconds handles ps elapsed formats", () => {
    expect(parseElapsedSeconds("00:05")).toBe(5);
    expect(parseElapsedSeconds("03:04")).toBe(184);
    expect(parseElapsedSeconds("01:02:03")).toBe(3723);
    expect(parseElapsedSeconds("2-03:04:05")).toBe(183845);
    expect(parseElapsedSeconds("bad")).toBe(0);
  });

  test("parseWorkerProcessTable recognizes released worker command shapes and stale tracking", () => {
    const currentRepo = createRepo("current", 101);
    const oldRepo = createRepo("old", 104);
    const untrackedRepo = createRepo("untracked");
    const removedRepo = join(tmpdir(), `lb-missing-${Date.now()}`);

    const workers = parseWorkerProcessTable(
      [
        "101 1 00:03:00 /opt/homebrew/bin/lb --worker",
        "102 1 00:12:00 /opt/homebrew/bin/bun run /tmp/lb-old/src/cli.ts --worker",
        "103 1 00:20:00 /opt/homebrew/bin/lb --export-worker",
        "104 1 00:45:00 /opt/homebrew/bin/lb --worker",
        "105 1 00:00:20 /opt/homebrew/bin/lb --worker",
        "106 1 00:00:20 /opt/homebrew/bin/lb worker whoami --worker codex-a",
        "107 1 00:00:20 /opt/homebrew/bin/lb auto next --worker codex-a",
      ].join("\n"),
      {
        currentRepoPath: currentRepo,
        trackedPid: 101,
        cwdResolver: (pid) => {
          switch (pid) {
            case 101:
              return currentRepo;
            case 102:
              return untrackedRepo;
            case 103:
              return currentRepo;
            case 104:
              return oldRepo;
            case 105:
              return removedRepo;
            default:
              return null;
          }
        },
      }
    );

    expect(workers.map((worker) => worker.pid)).toEqual([101, 102, 104, 105]);

    const currentWorker = workers.find((worker) => worker.pid === 101);
    expect(currentWorker).toBeDefined();
    expect(currentWorker?.currentRepo).toBe(true);
    expect(currentWorker?.trackedByCurrentRepo).toBe(true);
    expect(currentWorker?.trackedByRepo).toBe(true);
    expect(currentWorker?.zombieCandidate).toBe(false);

    const untrackedWorker = workers.find((worker) => worker.pid === 102);
    expect(untrackedWorker).toBeDefined();
    expect(untrackedWorker?.trackedByRepo).toBe(false);
    expect(untrackedWorker?.zombieCandidate).toBe(true);
    expect(untrackedWorker?.zombieReasons).toContain("untracked_age>600s");

    const trackedButOldWorker = workers.find((worker) => worker.pid === 104);
    expect(trackedButOldWorker).toBeDefined();
    expect(trackedButOldWorker?.trackedByRepo).toBe(true);
    expect(trackedButOldWorker?.zombieCandidate).toBe(true);
    expect(trackedButOldWorker?.zombieReasons).toContain("tracked_age>1800s");

    const missingRepoWorker = workers.find((worker) => worker.pid === 105);
    expect(missingRepoWorker).toBeDefined();
    expect(missingRepoWorker?.zombieCandidate).toBe(true);
    expect(missingRepoWorker?.zombieReasons).toContain("cwd_missing");
  });

  test("reapZombieWorkerProcesses terminates zombie candidates", async () => {
    if (process.platform === "win32") {
      return;
    }

    const child = Bun.spawn(["sleep", "30"], {
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      const worker: WorkerProcessInfo = {
        pid: child.pid,
        ppid: process.pid,
        elapsed: "00:30",
        elapsedSeconds: 30,
        command: "sleep 30",
        cwd: process.cwd(),
        repoPidFilePath: null,
        repoPidFilePid: null,
        currentRepo: true,
        trackedByCurrentRepo: false,
        trackedByRepo: false,
        zombieCandidate: true,
        zombieReasons: ["test"],
      };

      const results = await reapZombieWorkerProcesses([worker]);
      expect(results).toHaveLength(1);
      expect(results[0]?.pid).toBe(child.pid);
      expect(results[0]?.success).toBe(true);
      expect(isProcessAlive(child.pid)).toBe(false);
    } finally {
      try {
        child.kill();
      } catch {
        // Ignore cleanup races after successful reaping.
      }
    }
  });
});
