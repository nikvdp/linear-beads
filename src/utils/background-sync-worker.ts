/**
 * Background sync worker - processes outbox queue
 * Should be spawned as a detached process by write commands
 */

import { writePidFile, removePidFile } from "./pid-manager.js";
import { getPendingOutboxItems, removeOutboxItem, updateOutboxItemError } from "./database.js";
import {
  getTeamId,
  createIssue,
  updateIssue,
  updateIssueParent,
  closeIssue,
  deleteIssue,
  createRelation,
  fetchIssues,
  fetchRelations,
} from "./linear.js";
import { exportToJsonl } from "./jsonl.js";
import type { Issue, IssueType, Priority } from "../types.js";

/**
 * Process the outbox queue until empty
 */
async function processOutbox(): Promise<void> {
  // Write our PID first
  writePidFile(process.pid);

  try {
    while (true) {
      const items = getPendingOutboxItems();

      if (items.length === 0) {
        // Queue is empty - we're done
        break;
      }

      // Get team ID once for this batch
      const teamId = await getTeamId();

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

      // Brief pause before checking for more items
      await sleep(500);
    }

    // All done - pull latest from Linear and export to JSONL
    const teamId = await getTeamId();
    const issues = await fetchIssues(teamId);
    exportToJsonl();

    // Fetch relations in background (this is slow but user isn't waiting)
    const issueIds = issues.map((i) => i.id);
    await fetchRelations(issueIds);
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
