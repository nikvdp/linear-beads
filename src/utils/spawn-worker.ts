/**
 * Spawn background sync worker if not already running
 */

import { spawn } from "child_process";
import { openSync, closeSync } from "fs";
import { join, dirname } from "path";
import { isWorkerRunning, touchPidFile } from "./pid-manager.js";
import { getDbPath } from "./config.js";
import { queueOutboxItem } from "./database.js";
import type { OutboxItem } from "../types.js";

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

/**
 * Spawn background sync worker if needed
 * Returns true if spawned, false if already running
 */
function spawnWorker(): boolean {
  try {
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
  } catch (error) {
    console.error("Warning: Failed to spawn background sync worker:", error);
    return false;
  }
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
  payload: Record<string, unknown>
): void {
  queueOutboxItem(operation, payload);
  ensureOutboxProcessed();
}
