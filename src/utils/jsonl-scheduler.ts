/**
 * Debounced JSONL export scheduler.
 * Schedules an out-of-process export so foreground commands stay fast.
 */

import { spawn } from "child_process";

const DISABLED = process.argv.includes("--worker") || process.argv.includes("--export-worker");

let exportTimer: NodeJS.Timeout | null = null;
let exportInFlight = false;

/**
 * Spawn a lightweight export worker (compiled or bun dev) to write .lb/issues.jsonl.
 */
function spawnExportWorker(): void {
  // Avoid spawning multiple overlapping workers; give the last one a chance to run.
  if (exportInFlight) return;
  exportInFlight = true;

  try {
    const execPath = process.execPath;
    const isCompiled = execPath.endsWith("/lb") || execPath.endsWith("\\lb.exe");

    let cmd: string;
    let args: string[];

    if (isCompiled) {
      cmd = execPath;
      args = ["--export-worker"];
    } else {
      // Dev mode: run cli.ts through bun
      const cliPath = import.meta.path.replace(/jsonl-scheduler\.[tj]s$/, "../cli.ts");
      cmd = execPath;
      args = ["run", cliPath, "--export-worker"];
    }

    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
    });

    child.unref();
  } catch (error) {
    console.error("Warning: Failed to spawn JSONL export worker:", error);
  } finally {
    // Allow future spawns after a short buffer
    setTimeout(() => {
      exportInFlight = false;
    }, 2000);
  }
}

/**
 * Request an export, debounced to coalesce bursts of cache writes.
 */
export function requestJsonlExport(): void {
  if (DISABLED) return;

  if (exportTimer) {
    clearTimeout(exportTimer);
  }

  exportTimer = setTimeout(() => {
    exportTimer = null;
    spawnExportWorker();
  }, 750);
}
