/**
 * PID file management for background sync worker
 * Ensures only one sync worker runs per repo at a time
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
  statSync,
  utimesSync,
} from "fs";
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { getDbPath } from "./config.js";

const DEFAULT_UNTRACKED_ZOMBIE_WORKER_AGE_SECONDS = 10 * 60;
const DEFAULT_TRACKED_ZOMBIE_WORKER_AGE_SECONDS = 30 * 60;

export type WorkerProcessInfo = {
  pid: number;
  ppid: number;
  elapsed: string;
  elapsedSeconds: number;
  command: string;
  cwd: string | null;
  repoPidFilePath: string | null;
  repoPidFilePid: number | null;
  currentRepo: boolean;
  trackedByCurrentRepo: boolean;
  trackedByRepo: boolean;
  zombieCandidate: boolean;
  zombieReasons: string[];
};

/**
 * Get PID file path for a repo
 */
export function getPidFilePath(): string {
  const dbPath = getDbPath();
  const lbDir = dirname(dbPath);
  return join(lbDir, "sync.pid");
}

/**
 * Check if a process is alive
 */
export function isProcessAlive(pid: number): boolean {
  try {
    // Send signal 0 to check if process exists (doesn't kill it)
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

export function getWorkerPidFromFile(): number | null {
  const pidFile = getPidFilePath();
  return readPidFromPath(pidFile);
}

function readPidFromPath(pidFile: string): number | null {
  if (!existsSync(pidFile)) {
    return null;
  }

  try {
    const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function normalizeExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function parseElapsedSeconds(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }

  const [dayPart, timePart] = trimmed.includes("-") ? trimmed.split("-", 2) : [null, trimmed];
  const timeParts = timePart.split(":").map((part) => Number.parseInt(part, 10));
  if (timeParts.some((part) => !Number.isFinite(part))) {
    return 0;
  }

  const days = dayPart ? Number.parseInt(dayPart, 10) : 0;
  if (!Number.isFinite(days)) {
    return 0;
  }

  if (timeParts.length === 3) {
    return days * 86400 + timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2];
  }

  if (timeParts.length === 2) {
    return days * 86400 + timeParts[0] * 60 + timeParts[1];
  }

  return 0;
}

function looksLikeWorkerCommand(command: string): boolean {
  return /(?:^|\s)--worker\s*$/.test(command) && !command.includes("--export-worker");
}

function getProcessCwd(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      return readlinkSync(`/proc/${pid}/cwd`);
    }
  } catch {
    // Fall through to lsof on platforms where /proc is unavailable or restricted.
  }

  try {
    const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("n"));
    if (!match) {
      return null;
    }
    return match.slice(1).trim() || null;
  } catch {
    return null;
  }
}

function getRepoPidFilePath(repoPath: string): string {
  return join(repoPath, ".lb", "sync.pid");
}

export function parseWorkerProcessTable(
  psOutput: string,
  options: {
    currentRepoPath?: string;
    trackedPid?: number | null;
    cwdResolver?: (pid: number) => string | null;
    untrackedZombieAgeSeconds?: number;
    trackedZombieAgeSeconds?: number;
  } = {}
): WorkerProcessInfo[] {
  const currentRepoPath = normalizeExistingPath(options.currentRepoPath || process.cwd());
  const trackedPid = options.trackedPid ?? null;
  const cwdResolver = options.cwdResolver || getProcessCwd;
  const untrackedZombieAgeSeconds =
    options.untrackedZombieAgeSeconds || DEFAULT_UNTRACKED_ZOMBIE_WORKER_AGE_SECONDS;
  const trackedZombieAgeSeconds =
    options.trackedZombieAgeSeconds || DEFAULT_TRACKED_ZOMBIE_WORKER_AGE_SECONDS;

  const workers: WorkerProcessInfo[] = [];
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const elapsed = match[3];
    const command = match[4];
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !looksLikeWorkerCommand(command)) {
      continue;
    }

    const elapsedSeconds = parseElapsedSeconds(elapsed);
    const cwd = cwdResolver(pid);
    const normalizedCwd = cwd ? normalizeExistingPath(cwd) : null;
    const repoPidFilePath = normalizedCwd ? getRepoPidFilePath(normalizedCwd) : null;
    const repoPidFilePid = repoPidFilePath ? readPidFromPath(repoPidFilePath) : null;
    const trackedByRepo = repoPidFilePid !== null && repoPidFilePid === pid;
    const zombieReasons: string[] = [];
    if (normalizedCwd && !existsSync(normalizedCwd)) {
      zombieReasons.push("cwd_missing");
    }
    if (!trackedByRepo && elapsedSeconds >= untrackedZombieAgeSeconds) {
      zombieReasons.push(`untracked_age>${untrackedZombieAgeSeconds}s`);
    }
    if (trackedByRepo && elapsedSeconds >= trackedZombieAgeSeconds) {
      zombieReasons.push(`tracked_age>${trackedZombieAgeSeconds}s`);
    }

    workers.push({
      pid,
      ppid,
      elapsed,
      elapsedSeconds,
      command,
      cwd: normalizedCwd,
      repoPidFilePath,
      repoPidFilePid,
      currentRepo: normalizedCwd === currentRepoPath,
      trackedByCurrentRepo: trackedPid !== null && pid === trackedPid,
      trackedByRepo,
      zombieCandidate: zombieReasons.length > 0,
      zombieReasons,
    });
  }

  return workers.sort((left, right) => left.pid - right.pid);
}

export function inspectWorkerProcesses(): WorkerProcessInfo[] {
  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,etime=,command="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseWorkerProcessTable(output, {
      trackedPid: getWorkerPidFromFile(),
    });
  } catch {
    return [];
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}

export async function reapZombieWorkerProcesses(
  workers: WorkerProcessInfo[]
): Promise<Array<{ pid: number; signal: "SIGTERM" | "SIGKILL"; success: boolean }>> {
  const results: Array<{ pid: number; signal: "SIGTERM" | "SIGKILL"; success: boolean }> = [];

  for (const worker of workers.filter((entry) => entry.zombieCandidate)) {
    try {
      process.kill(worker.pid, "SIGTERM");
      const exited = await waitForProcessExit(worker.pid, 750);
      if (exited) {
        results.push({ pid: worker.pid, signal: "SIGTERM", success: true });
        continue;
      }
    } catch {
      results.push({ pid: worker.pid, signal: "SIGTERM", success: false });
      continue;
    }

    try {
      process.kill(worker.pid, "SIGKILL");
      const exited = await waitForProcessExit(worker.pid, 500);
      results.push({ pid: worker.pid, signal: "SIGKILL", success: exited });
    } catch {
      results.push({ pid: worker.pid, signal: "SIGKILL", success: false });
    }
  }

  return results;
}

/**
 * Check if a background sync worker is already running
 * Returns true if worker is running, false otherwise
 */
export function isWorkerRunning(): boolean {
  const pidFile = getPidFilePath();

  if (!existsSync(pidFile)) {
    return false;
  }

  try {
    const pidStr = readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(pidStr);

    if (isNaN(pid)) {
      // Invalid PID file - remove it
      unlinkSync(pidFile);
      return false;
    }

    if (!isProcessAlive(pid)) {
      // Stale PID file - process died
      unlinkSync(pidFile);
      return false;
    }

    return true;
  } catch {
    // Error reading file - assume not running
    return false;
  }
}

/**
 * Write PID file for current process
 */
export function writePidFile(pid: number): void {
  const pidFile = getPidFilePath();
  const dir = dirname(pidFile);

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(pidFile, pid.toString());
}

/**
 * Remove PID file when worker exits
 */
export function removePidFile(): void {
  const pidFile = getPidFilePath();

  if (existsSync(pidFile)) {
    try {
      unlinkSync(pidFile);
    } catch {
      // Ignore errors - file might not exist
    }
  }
}

/**
 * Get PID file mtime (for detecting "stay alive" signals)
 * Returns 0 if file doesn't exist
 */
export function getPidFileMtime(): number {
  const pidFile = getPidFilePath();
  try {
    const stat = statSync(pidFile);
    return stat.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Touch PID file to signal worker to stay alive
 */
export function touchPidFile(): void {
  const pidFile = getPidFilePath();
  if (existsSync(pidFile)) {
    const now = new Date();
    utimesSync(pidFile, now, now);
  }
}

/**
 * Kill running worker (for testing/cleanup)
 */
export function killWorker(): boolean {
  const pidFile = getPidFilePath();

  if (!existsSync(pidFile)) {
    return false;
  }

  try {
    const pidStr = readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(pidStr);

    if (isNaN(pid)) {
      unlinkSync(pidFile);
      return false;
    }

    if (isProcessAlive(pid)) {
      process.kill(pid, "SIGTERM");
      unlinkSync(pidFile);
      return true;
    }

    // Stale PID
    unlinkSync(pidFile);
    return false;
  } catch {
    return false;
  }
}
