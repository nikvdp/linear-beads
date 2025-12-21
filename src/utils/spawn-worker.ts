/**
 * Spawn background sync worker if not already running
 */

import { spawn, spawnSync } from "child_process";
import { isWorkerRunning } from "./pid-manager.js";


/**
 * Get the command and args to run the worker
 */
function getWorkerCommand(): { cmd: string; args: string[] } {
  const execPath = process.execPath;
  const isCompiled = execPath.endsWith("/lb") || execPath.endsWith("\\lb.exe");

  if (isCompiled) {
    return { cmd: execPath, args: ["--worker"] };
  } else {
    // Dev mode: need to run bun with the script
    const cliPath = import.meta.path.replace(/spawn-worker\.[tj]s$/, "../cli.ts");
    return { cmd: execPath, args: ["run", cliPath, "--worker"] };
  }
}

/**
 * Spawn background sync worker if needed
 * Returns true if spawned, false if already running
 */
export function spawnWorkerIfNeeded(): boolean {
  // Check if worker already running
  if (isWorkerRunning()) {
    return false;
  }

  try {
    const { cmd, args } = getWorkerCommand();

    const worker = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
    });

    // Unref so parent can exit
    worker.unref();

    return true;
  } catch (error) {
    // Log but don't fail - user can manually sync
    console.error("Warning: Failed to spawn background sync worker:", error);
    return false;
  }
}

/**
 * Ensure outbox is processed. If a worker is already running, trust it.
 * Otherwise, process synchronously to guarantee delivery.
 */
export function ensureOutboxProcessed(): void {
  // If worker is already running, it will pick up the new item
  if (isWorkerRunning()) {
    return;
  }

  // No worker running - process synchronously to guarantee delivery.
  // This blocks but ensures writes always reach Linear.
  const { cmd, args } = getWorkerCommand();
  spawnSync(cmd, args, {
    cwd: process.cwd(),
    stdio: "ignore",
  });
}
