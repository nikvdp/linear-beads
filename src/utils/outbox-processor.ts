/**
 * Outbox processing with deferred replay for local-first mode
 */

import type { Issue, IssueType, OutboxItem, Priority } from "../types.js";
import {
  getPendingOutboxItems,
  removeOutboxItem,
  claimOutboxItem,
  releaseOutboxItemClaim,
  updateOutboxItemError,
  setIssueIdMapping,
  replaceIssueId,
  getParentId,
  getChildIds,
  getCachedIssue,
  isLocalId,
  resolveIssueId as resolveRemoteIssueId,
  resolveIssueLocalId,
  updateMailMessageSyncStatus,
} from "./database.js";
import {
  createIssue,
  updateIssue,
  updateIssueParent,
  closeIssue,
  deleteIssue,
  createRelation,
  deleteRelation,
} from "./issue-backend.js";
import { getMailBackendAdapter } from "./mail-backend.js";

function resolveDepsString(
  deps: string,
  unresolvedLocalIds: Set<string>,
  referencedIds: Set<string>
): string {
  const resolved = deps
    .split(",")
    .map((dep) => dep.trim())
    .filter(Boolean)
    .map((dep) => {
      const [type, targetId] = dep.split(":");
      if (!targetId) return dep;
      referencedIds.add(targetId);
      const resolved = resolveRemoteIssueId(targetId);
      if (isLocalId(targetId) && resolved === targetId) {
        unresolvedLocalIds.add(targetId);
        return dep;
      }
      return `${type}:${resolved}`;
    });

  return resolved.join(",");
}

function getPrimaryId(item: OutboxItem): string | undefined {
  if (item.local_id) return item.local_id;
  const payload = item.payload as Record<string, unknown>;
  const issueId = payload.issueId;
  if (typeof issueId === "string") return issueId;
  const issueA = payload.issueA;
  if (typeof issueA === "string") return issueA;
  return undefined;
}

function resolveOutboxItem(item: OutboxItem): {
  canProcess: boolean;
  primaryId?: string;
  referencedIds: string[];
  resolvedPayload?: Record<string, unknown>;
} {
  const payload = { ...(item.payload as Record<string, unknown>) };
  const unresolvedLocalIds = new Set<string>();
  const referencedIds = new Set<string>();
  const primaryId = getPrimaryId(item);

  const resolveField = (key: string): void => {
    const value = payload[key];
    if (typeof value !== "string") return;
    referencedIds.add(value);
    const resolved = resolveRemoteIssueId(value);
    if (isLocalId(value) && resolved === value) {
      unresolvedLocalIds.add(value);
      return;
    }
    payload[key] = resolved;
  };

  switch (item.operation) {
    case "create": {
      resolveField("parentId");
      if (typeof payload.deps === "string") {
        payload.deps = resolveDepsString(payload.deps, unresolvedLocalIds, referencedIds);
      }
      break;
    }
    case "update": {
      resolveField("issueId");
      resolveField("parentId");
      if (typeof payload.deps === "string") {
        payload.deps = resolveDepsString(payload.deps, unresolvedLocalIds, referencedIds);
      }
      break;
    }
    case "close":
    case "delete": {
      resolveField("issueId");
      break;
    }
    case "create_relation": {
      resolveField("issueId");
      resolveField("relatedIssueId");
      break;
    }
    case "delete_relation": {
      resolveField("issueA");
      resolveField("issueB");
      break;
    }
    case "mail_send":
    case "mail_mark_read":
    case "mail_ack":
    case "mail_reply": {
      resolveField("messageId");
      resolveField("replyToMessageId");
      break;
    }
  }

  if (unresolvedLocalIds.size > 0) {
    return {
      canProcess: false,
      primaryId,
      referencedIds: [...referencedIds],
    };
  }

  return {
    canProcess: true,
    primaryId,
    referencedIds: [...referencedIds],
    resolvedPayload: payload,
  };
}

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
    if (parent.status === "open") {
      try {
        await updateIssue(parentId, { status: "in_progress" }, teamId);
      } catch {
        return;
      }
    }
  } else if (newStatus === "closed") {
    const siblingIds = getChildIds(parentId);
    const hasActiveWork = siblingIds.some((sibId) => {
      if (sibId === issueId) return false;
      const sib = getCachedIssue(sibId);
      return sib?.status === "in_progress";
    });

    if (!hasActiveWork && parent.status === "in_progress") {
      try {
        await updateIssue(parentId, { status: "open" }, teamId);
      } catch {
        return;
      }
    }
  }
}

async function processResolvedItem(
  item: OutboxItem,
  payload: Record<string, unknown>,
  teamId: string,
  propagateParent: boolean
): Promise<{ usedRemoteBackend: boolean }> {
  const mailBackend = getMailBackendAdapter();

  switch (item.operation) {
    case "create": {
      const localId = item.local_id;
      if (!localId) {
        throw new Error("Missing local_id for create operation");
      }
      const createPayload = payload as {
        title: string;
        description?: string;
        priority: Priority;
        issueType?: IssueType;
        parentId?: string;
        deps?: string;
      };
      const issue = await createIssue({
        title: createPayload.title,
        description: createPayload.description,
        priority: createPayload.priority,
        issueType: createPayload.issueType,
        parentId: createPayload.parentId,
        teamId,
      });

      setIssueIdMapping(localId, issue.id);
      replaceIssueId(localId, issue.id, issue.linear_id);

      if (createPayload.deps) {
        const deps = createPayload.deps.split(",").map((dep: string) => {
          const [type, targetId] = dep.trim().split(":");
          return { type, targetId };
        });
        for (const dep of deps) {
          try {
            if (dep.type === "blocked-by") {
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
      return { usedRemoteBackend: true };
    }
    case "update": {
      const updatePayload = payload as {
        issueId: string;
        title?: string;
        description?: string;
        status?: Issue["status"];
        priority?: Priority;
        deps?: string;
        parentId?: string | null;
      };
      await updateIssue(updatePayload.issueId, updatePayload, teamId);

      if (propagateParent && updatePayload.status) {
        await propagateStatusToParent(updatePayload.issueId, updatePayload.status, teamId);
      }

      // Handle parent update - check for key existence, not truthiness (null means remove parent)
      if ("parentId" in updatePayload) {
        try {
          await updateIssueParent(updatePayload.issueId, updatePayload.parentId ?? null);
        } catch {
          // Ignore parent update failures in background
        }
      }

      if (updatePayload.deps) {
        const deps = updatePayload.deps.split(",").map((dep: string) => {
          const [type, targetId] = dep.trim().split(":");
          return { type, targetId };
        });
        for (const dep of deps) {
          try {
            if (dep.type === "blocked-by") {
              await createRelation(dep.targetId, updatePayload.issueId, "blocks");
            } else {
              const relationType = dep.type === "blocks" ? "blocks" : "related";
              await createRelation(
                updatePayload.issueId,
                dep.targetId,
                relationType as "blocks" | "related"
              );
            }
          } catch {
            // Ignore relation creation failures in background
          }
        }
      }
      return { usedRemoteBackend: true };
    }
    case "close": {
      const closePayload = payload as {
        issueId: string;
        reason?: string;
      };
      await closeIssue(closePayload.issueId, teamId, closePayload.reason);
      if (propagateParent) {
        await propagateStatusToParent(closePayload.issueId, "closed", teamId);
      }
      return { usedRemoteBackend: true };
    }
    case "create_relation": {
      const relPayload = payload as {
        issueId: string;
        relatedIssueId: string;
        type: "blocks" | "related";
      };
      await createRelation(relPayload.issueId, relPayload.relatedIssueId, relPayload.type);
      return { usedRemoteBackend: true };
    }
    case "delete": {
      const deletePayload = payload as {
        issueId: string;
      };
      await deleteIssue(deletePayload.issueId);
      return { usedRemoteBackend: true };
    }
    case "delete_relation": {
      const relPayload = payload as {
        issueA: string;
        issueB: string;
      };
      await deleteRelation(relPayload.issueA, relPayload.issueB);
      return { usedRemoteBackend: true };
    }
    case "mail_send":
    case "mail_reply": {
      const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
      if (!messageId) {
        throw new Error(`Missing messageId for ${item.operation}`);
      }

      if (item.operation === "mail_send") {
        await mailBackend.send(messageId);
      } else {
        await mailBackend.reply(messageId);
      }

      updateMailMessageSyncStatus(messageId, "synced");
      return { usedRemoteBackend: mailBackend.name !== "local" };
    }
    case "mail_mark_read":
    case "mail_ack": {
      const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
      const recipientAgentId =
        typeof payload.recipientAgentId === "string" ? payload.recipientAgentId : "";
      if (!messageId || !recipientAgentId) {
        throw new Error(`Missing messageId or recipientAgentId for ${item.operation}`);
      }

      if (item.operation === "mail_mark_read") {
        await mailBackend.markRead(messageId, recipientAgentId);
      } else {
        await mailBackend.ack(messageId, recipientAgentId);
      }
      return { usedRemoteBackend: mailBackend.name !== "local" };
    }
    default:
      throw new Error(`Unknown operation: ${item.operation}`);
  }
}

export function operationRequiresTeamId(operation: OutboxItem["operation"]): boolean {
  switch (operation) {
    case "create":
    case "update":
    case "close":
    case "delete":
    case "create_relation":
    case "delete_relation":
      return true;
    case "mail_send":
    case "mail_mark_read":
    case "mail_ack":
    case "mail_reply":
      return false;
  }
}

export async function processOutboxQueue(
  teamId: string,
  options: { propagateParent?: boolean } = {}
): Promise<{ success: number; failed: number; deferred: number; remoteProcessed: number }> {
  const items = getPendingOutboxItems();
  let success = 0;
  let failed = 0;
  let deferred = 0;
  let remoteProcessed = 0;
  const blockedIssueIds = new Set<string>();
  const propagateParent = options.propagateParent === true;

  const addBlockedId = (id: string): void => {
    blockedIssueIds.add(id);
    const localId = resolveIssueLocalId(id);
    blockedIssueIds.add(localId);
    blockedIssueIds.add(resolveRemoteIssueId(localId));
    blockedIssueIds.add(resolveRemoteIssueId(id));
  };

  const isBlocked = (id: string): boolean => {
    if (blockedIssueIds.has(id)) return true;
    const localId = resolveIssueLocalId(id);
    if (blockedIssueIds.has(localId)) return true;
    return blockedIssueIds.has(resolveRemoteIssueId(id));
  };

  for (const item of items) {
    const resolution = resolveOutboxItem(item);

    if (resolution.primaryId && isBlocked(resolution.primaryId)) {
      deferred++;
      continue;
    }
    if (resolution.referencedIds.some((id) => isBlocked(id))) {
      deferred++;
      continue;
    }

    if (!claimOutboxItem(item.id)) {
      deferred++;
      continue;
    }

    const claimedResolution = resolveOutboxItem(item);
    if (!claimedResolution.canProcess || !claimedResolution.resolvedPayload) {
      releaseOutboxItemClaim(item.id);
      if (claimedResolution.primaryId) {
        addBlockedId(claimedResolution.primaryId);
      }
      for (const id of claimedResolution.referencedIds) {
        addBlockedId(id);
      }
      deferred++;
      continue;
    }

    try {
      if (operationRequiresTeamId(item.operation) && !teamId) {
        throw new Error(`Missing teamId for operation: ${item.operation}`);
      }
      const result = await processResolvedItem(
        item,
        claimedResolution.resolvedPayload,
        teamId,
        propagateParent
      );
      if (result.usedRemoteBackend) {
        remoteProcessed++;
      }
      removeOutboxItem(item.id);
      success++;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      updateOutboxItemError(item.id, errorMsg);
      failed++;
    }
  }

  return { success, failed, deferred, remoteProcessed };
}
