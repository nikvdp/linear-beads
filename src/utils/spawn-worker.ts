/**
 * Spawn background sync worker if not already running
 */

import { spawn } from "child_process";
import { openSync, closeSync, statSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { isWorkerRunning, touchPidFile } from "./pid-manager.js";
import { getDbPath } from "./config.js";
import { queueOutboxItem } from "./database.js";
import type { OutboxItem } from "../types.js";

const SPAWN_LOCK_TTL_MS = 5000;

/**
 * Get the command and args to run the worker
 */
function getWorkerCommand(): { cmd: string; args: string[] } {
  const execPath = process.execPath;
  const isCompiled = execPath.endsWith("/lb") || execPath.endsWith("\\lb.exe");

  if (isCompiled) {
    return { cmd: execPath, args: ["--worker"] };
  } else {
    // Dev mode: use URL-based resolution for robustness
    const cliPath = new URL("../cli.ts", import.meta.url).pathname;
    return { cmd: execPath, args: ["run", cliPath, "--worker"] };
  }
}

function getLogFilePath(): string {
  return join(dirname(getDbPath()), "sync.log");
}

function getSpawnLockPath(): string {
  return join(dirname(getDbPath()), "sync.spawn.lock");
}

function withSpawnLock<T>(operation: () => T): T | null {
  const lockPath = getSpawnLockPath();

  try {
    const stat = statSync(lockPath);
    if (Date.now() - stat.mtimeMs > SPAWN_LOCK_TTL_MS) {
      unlinkSync(lockPath);
    }
  } catch {
    // No lock file
  }

  let lockFd: number;
  try {
    lockFd = openSync(lockPath, "wx");
  } catch {
    // Another process is spawning the worker right now.
    return null;
  }

  try {
    return operation();
  } finally {
    closeSync(lockFd);
    try {
      unlinkSync(lockPath);
    } catch {
      // If lock was already removed, ignore.
    }
  }
}

/**
 * Spawn background sync worker if needed
 * Returns true if spawned, false if already running
 */
function spawnWorker(): boolean {
  const spawned = withSpawnLock(() => {
    if (isWorkerRunning()) {
      return false;
    }

    const { cmd, args } = getWorkerCommand();

    // Log to file for debugging spawn failures
    const logFd = openSync(getLogFilePath(), "a");

    const worker = spawn(cmd, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: process.cwd(),
    });

    worker.unref();
    closeSync(logFd);

    return true;
  });

  if (spawned === null) {
    return false;
  }

  return spawned;
}

/**
 * Ensure outbox will be processed.
 * - If worker is running: touch PID file to signal "stay alive"
 * - If worker not running: spawn it
 */
export function ensureOutboxProcessed(): void {
  if (isWorkerRunning()) {
    // Worker is running - touch PID file to signal new work
    touchPidFile();
  } else {
    // No worker - spawn one
    spawnWorker();
  }
}

/**
 * Queue an operation and ensure it gets processed.
 * This is the main entry point for async write operations.
 */
export function queueOperation(
  operation: OutboxItem["operation"],
  payload: Record<string, unknown>,
  localId?: string
): void {
  queueOutboxItem(operation, payload, localId);
  ensureOutboxProcessed();
}
