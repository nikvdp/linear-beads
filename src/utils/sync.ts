/**
 * Sync operations - push outbox and pull from Linear
 */

import {
  getPendingOutboxItems,
  removeOutboxItem,
  updateOutboxItemError,
  isCacheStale,
} from "./database.js";
import {
  fetchIssues,
  getTeamId,
  createIssue,
  updateIssue,
  closeIssue,
  createRelation,
} from "./linear.js";
import { exportToJsonl } from "./jsonl.js";
import type { Issue, IssueType, Priority } from "../types.js";

/**
 * Process outbox queue - push pending mutations to Linear
 */
export async function pushOutbox(teamId: string): Promise<{ success: number; failed: number }> {
  const items = getPendingOutboxItems();
  let success = 0;
  let failed = 0;

  for (const item of items) {
    try {
      switch (item.operation) {
        case "create": {
          const payload = item.payload as {
            title: string;
            description?: string;
            priority: Priority;
            issueType?: IssueType;
            parentId?: string;
          };
          await createIssue({
            ...payload,
            teamId,
          });
          break;
        }
        case "update": {
          const payload = item.payload as {
            issueId: string;
            title?: string;
            description?: string;
            status?: Issue["status"];
            priority?: Priority;
          };
          await updateIssue(payload.issueId, payload, teamId);
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
      }
      removeOutboxItem(item.id);
      success++;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      updateOutboxItemError(item.id, errorMsg);
      failed++;
    }
  }

  return { success, failed };
}

/**
 * Pull issues from Linear and update cache
 */
export async function pullFromLinear(teamId: string): Promise<Issue[]> {
  // No clearCache - fetchIssues uses upsert (INSERT OR REPLACE)
  return fetchIssues(teamId);
}

/**
 * Full sync - push then pull
 */
export async function fullSync(teamKey?: string): Promise<{
  pushed: { success: number; failed: number };
  pulled: number;
}> {
  const teamId = await getTeamId(teamKey);

  // Push first
  const pushed = await pushOutbox(teamId);

  // Then pull
  const issues = await pullFromLinear(teamId);

  // Export to JSONL
  exportToJsonl();

  return {
    pushed,
    pulled: issues.length,
  };
}

/**
 * Check if sync is needed and optionally perform it
 */
export async function ensureFresh(teamKey?: string, force: boolean = false): Promise<boolean> {
  if (!force && !isCacheStale()) {
    return false; // Cache is fresh
  }

  await fullSync(teamKey);
  return true; // Synced
}
