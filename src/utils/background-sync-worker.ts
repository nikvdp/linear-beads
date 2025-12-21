/**
 * Background sync worker - processes outbox queue
 * Should be spawned as a detached process by write commands
 * 
 * Polls outbox every 500ms, exits after 5s of inactivity.
 * Parent can touch PID file to signal "stay alive" for new work.
 */

import { writePidFile, removePidFile, getPidFileMtime } from "./pid-manager.js";
import { getPendingOutboxItems, removeOutboxItem, updateOutboxItemError, getParentId, getChildIds, getCachedIssue } from "./database.js";
import {
  getTeamId,
  createIssue,
  updateIssue,
  updateIssueParent,
  closeIssue,
  deleteIssue,
  createRelation,
  deleteRelation,
  fetchIssues,
} from "./linear.js";
import { exportToJsonl } from "./jsonl.js";
import type { Issue, IssueType, Priority } from "../types.js";

const IDLE_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 500;

/**
 * Propagate status changes to parent issue.
 * - When child goes in_progress: set parent to in_progress (if open)
 * - When child closes: if no other children in_progress, set parent to open
 */
async function propagateStatusToParent(
  issueId: string,
  newStatus: string,
  teamId: string
): Promise<void> {
  const parentId = getParentId(issueId);
  if (!parentId) return;

  const parent = getCachedIssue(parentId);
  if (!parent) return;

  if (newStatus === "in_progress") {
    // Child started work - parent should also be in_progress
    if (parent.status === "open") {
      try {
        await updateIssue(parentId, { status: "in_progress" }, teamId);
      } catch {
        // Ignore - best effort
      }
    }
  } else if (newStatus === "closed") {
    // Child finished - check if any siblings still in_progress
    const siblingIds = getChildIds(parentId);
    const hasActiveWork = siblingIds.some((sibId) => {
      if (sibId === issueId) return false; // Skip self
      const sib = getCachedIssue(sibId);
      return sib?.status === "in_progress";
    });

    if (!hasActiveWork && parent.status === "in_progress") {
      try {
        await updateIssue(parentId, { status: "open" }, teamId);
      } catch {
        // Ignore - best effort
      }
    }
  }
}

/**
 * Process the outbox queue with polling and idle timeout
 */
async function processOutbox(): Promise<void> {
  // Write our PID first
  writePidFile(process.pid);

  let lastActivityTime = Date.now();
  let lastPidMtime = getPidFileMtime();
  let teamId: string | null = null;
  let didWork = false;

  try {
    while (true) {
      const items = getPendingOutboxItems();

      if (items.length > 0) {
        // We have work - reset idle timer
        lastActivityTime = Date.now();
        didWork = true;

        // Get team ID once (cache it)
        if (!teamId) {
          teamId = await getTeamId();
        }

        // Process items one by one
        for (const item of items) {
          try {
            await processOutboxItem(item, teamId);
            removeOutboxItem(item.id);
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(`Failed to process outbox item ${item.id}:`, errorMsg);
            updateOutboxItemError(item.id, errorMsg);

            // Brief pause before continuing to next item
            await sleep(1000);
          }
        }
      } else {
        // No items - check if we should stay alive
        const currentPidMtime = getPidFileMtime();
        
        // If PID file was touched since last check, reset idle timer
        if (currentPidMtime > lastPidMtime) {
          lastActivityTime = Date.now();
          lastPidMtime = currentPidMtime;
        }

        // Check if we've been idle too long
        if (Date.now() - lastActivityTime > IDLE_TIMEOUT_MS) {
          break;
        }
      }

      // Poll interval
      await sleep(POLL_INTERVAL_MS);
    }

    // Only sync if we actually did work
    if (didWork) {
      if (!teamId) {
        teamId = await getTeamId();
      }
      await fetchIssues(teamId);
      exportToJsonl();
    }

    // Note: We intentionally skip fetching relations here.
    // Fetching relations for all issues is O(n) API calls which is too slow.
    // Relations are fetched on-demand via `lb show <id> --sync`.
  } finally {
    // Clean up PID file when exiting
    removePidFile();
  }
}

/**
 * Process a single outbox item
 */
async function processOutboxItem(item: any, teamId: string): Promise<void> {
  switch (item.operation) {
    case "create": {
      const payload = item.payload as {
        title: string;
        description?: string;
        priority: Priority;
        issueType?: IssueType;
        parentId?: string;
        deps?: string;
      };
      const issue = await createIssue({
        title: payload.title,
        description: payload.description,
        priority: payload.priority,
        issueType: payload.issueType,
        parentId: payload.parentId,
        teamId,
      });

      // Handle deps after issue creation
      if (payload.deps) {
        const deps = payload.deps.split(",").map((dep: string) => {
          const [type, targetId] = dep.trim().split(":");
          return { type, targetId };
        });
        for (const dep of deps) {
          try {
            if (dep.type === "blocked-by") {
              // blocked-by is inverse: target blocks this issue
              await createRelation(dep.targetId, issue.id, "blocks");
            } else {
              const relationType = dep.type === "blocks" ? "blocks" : "related";
              await createRelation(issue.id, dep.targetId, relationType as "blocks" | "related");
            }
          } catch {
            // Ignore relation creation failures in background
          }
        }
      }
      break;
    }

    case "update": {
      const payload = item.payload as {
        issueId: string;
        title?: string;
        description?: string;
        status?: Issue["status"];
        priority?: Priority;
        deps?: string;
        parentId?: string;
      };
      await updateIssue(payload.issueId, payload, teamId);

      // Propagate status changes to parent
      if (payload.status) {
        await propagateStatusToParent(payload.issueId, payload.status, teamId);
      }

      // Handle parent after update
      if (payload.parentId) {
        try {
          await updateIssueParent(payload.issueId, payload.parentId);
        } catch {
          // Ignore parent update failures in background
        }
      }

      // Handle deps after update
      if (payload.deps) {
        const deps = payload.deps.split(",").map((dep: string) => {
          const [type, targetId] = dep.trim().split(":");
          return { type, targetId };
        });
        for (const dep of deps) {
          try {
            if (dep.type === "blocked-by") {
              // blocked-by is inverse: target blocks this issue
              await createRelation(dep.targetId, payload.issueId, "blocks");
            } else {
              const relationType = dep.type === "blocks" ? "blocks" : "related";
              await createRelation(payload.issueId, dep.targetId, relationType as "blocks" | "related");
            }
          } catch {
            // Ignore relation creation failures in background
          }
        }
      }
      break;
    }

    case "close": {
      const payload = item.payload as {
        issueId: string;
        reason?: string;
      };
      await closeIssue(payload.issueId, teamId, payload.reason);

      // Propagate close to parent
      await propagateStatusToParent(payload.issueId, "closed", teamId);
      break;
    }

    case "create_relation": {
      const payload = item.payload as {
        issueId: string;
        relatedIssueId: string;
        type: "blocks" | "related";
      };
      await createRelation(payload.issueId, payload.relatedIssueId, payload.type);
      break;
    }

    case "delete": {
      const payload = item.payload as {
        issueId: string;
      };
      await deleteIssue(payload.issueId);
      break;
    }

    case "delete_relation": {
      const payload = item.payload as {
        issueA: string;
        issueB: string;
      };
      await deleteRelation(payload.issueA, payload.issueB);
      break;
    }

    default:
      throw new Error(`Unknown operation: ${item.operation}`);
  }
}

/**
 * Sleep for ms milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main entry point when run as a script
 */
if (import.meta.main) {
  processOutbox()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error("Worker failed:", error);
      removePidFile();
      process.exit(1);
    });
}

export { processOutbox };
