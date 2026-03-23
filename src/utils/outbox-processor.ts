/**
 * Outbox processing with deferred replay for local-first mode
 */

import {
  isTerminalStatus,
  type Issue,
  type IssueType,
  type OutboxItem,
  type Priority,
} from "../types.js";
import {
  cacheIssue,
  getPendingOutboxItems,
  removeOutboxItem,
  claimOutboxItem,
  releaseOutboxItemClaim,
  updateOutboxItemError,
  getIssueIdMapping,
  replaceIssueId,
  getLinearIdForLocalId,
  ensureIssueSyncKey,
  getIssueSyncKey,
  getSyncedIssueBySyncKey,
  markOutboxCreateRemoteIssueIdentifier,
  getParentId,
  getChildIds,
  getCachedIssue,
  cacheDependency,
  isLocalId,
  isPlausibleIssueInput,
  isPlaceholderIssueInput,
  repairSelfReferentialDependencies,
  resolveIssueId as resolveRemoteIssueId,
  resolveIssueLocalId,
  updateMailMessageSyncStatus,
  queueOutboxItem,
} from "./database.js";
import {
  createIssue,
  updateIssue,
  updateIssueParent,
  closeIssue,
  deleteIssue,
  createRelation,
  deleteRelation,
  findIssueBySyncKey,
} from "./issue-backend.js";
import { getMailBackendAdapter } from "./mail-backend.js";
import { toCanonicalLocalDescription } from "./linear.js";
import {
  getAutomaticRemoteSyncPauseForEndpoints,
  recordRemoteSyncPause,
} from "./remote-sync-state.js";

type ResolutionContext = {
  pendingCreateLocalIds: Set<string>;
};

type ResolutionResult = {
  canProcess: boolean;
  dropOperation: boolean;
  primaryId?: string;
  referencedIds: string[];
  unresolvedLocalIds: string[];
  resolvedPayload?: Record<string, unknown>;
};

function isSameCanonicalIssue(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  return canonicalLocalId(left) === canonicalLocalId(right);
}

function canonicalLocalId(id: string): string {
  return resolveIssueLocalId(id);
}

function shouldBlockUnresolvedLocalId(
  localId: string,
  pendingCreateLocalIds: Set<string>
): boolean {
  const canonical = canonicalLocalId(localId);
  return !(isLocalId(canonical) && pendingCreateLocalIds.has(canonical));
}

function queueRelationRetry(
  issueId: string,
  relatedIssueId: string,
  type: "blocks" | "related"
): void {
  if (isSameCanonicalIssue(issueId, relatedIssueId)) {
    return;
  }
  queueOutboxItem("create_relation", {
    issueId,
    relatedIssueId,
    type,
  });
}

function payloadReferencesMedia(payload: Record<string, unknown>): boolean {
  for (const value of Object.values(payload)) {
    if (typeof value === "string" && value.includes("lb-media:")) {
      return true;
    }
  }
  return false;
}

function isPlaceholderIssueRef(value: string): boolean {
  return isPlaceholderIssueInput(value);
}

function reviveIssueFromCreateOutbox(item: OutboxItem): boolean {
  if (item.operation !== "create" || !item.local_id) {
    return false;
  }

  const payload = item.payload as Record<string, unknown>;
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (!title) {
    return false;
  }

  const parsedPriority =
    typeof payload.priority === "number"
      ? payload.priority
      : typeof payload.priority === "string"
        ? Number.parseInt(payload.priority, 10)
        : NaN;
  const priority = Number.isFinite(parsedPriority) ? (parsedPriority as Priority) : 2;
  const createdAt =
    typeof item.created_at === "string" && item.created_at.trim()
      ? item.created_at
      : new Date().toISOString();
  const syncKey =
    typeof payload.syncKey === "string" && payload.syncKey.trim()
      ? payload.syncKey.trim()
      : undefined;

  cacheIssue({
    id: item.local_id,
    title,
    description:
      typeof payload.description === "string"
        ? toCanonicalLocalDescription(payload.description)
        : undefined,
    status: "open",
    priority,
    issue_type:
      typeof payload.issueType === "string" ? (payload.issueType as IssueType) : undefined,
    sync_status: "pending",
    created_at: createdAt,
    updated_at: createdAt,
    sync_key: syncKey,
  });

  if (typeof payload.parentId === "string" && !isPlaceholderIssueRef(payload.parentId)) {
    cacheDependency({
      issue_id: item.local_id,
      depends_on_id: payload.parentId,
      type: "parent-child",
      created_at: createdAt,
      created_by: "local",
    });
  }

  if (typeof payload.deps === "string") {
    for (const dep of payload.deps
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      const [type, targetId] = dep.split(":");
      if (!targetId || isPlaceholderIssueRef(targetId)) {
        continue;
      }
      if (type === "blocked-by") {
        cacheDependency({
          issue_id: targetId,
          depends_on_id: item.local_id,
          type: "blocks",
          created_at: createdAt,
          created_by: "local",
        });
        continue;
      }

      const depType = type === "blocks" ? "blocks" : "related";
      cacheDependency({
        issue_id: item.local_id,
        depends_on_id: targetId,
        type: depType as "blocks" | "related",
        created_at: createdAt,
        created_by: "local",
      });
    }
  }

  return true;
}

function isOrphanUnresolvedLocalId(localId: string, context: ResolutionContext): boolean {
  const canonical = canonicalLocalId(localId);
  if (!isLocalId(canonical)) return false;
  if (context.pendingCreateLocalIds.has(canonical)) return false;
  if (getCachedIssue(canonical)) return false;
  if (getIssueIdMapping(canonical)) return false;
  return true;
}

function resolveDepsString(
  deps: string,
  unresolvedLocalIds: Set<string>,
  referencedIds: Set<string>,
  context: ResolutionContext,
  primaryId?: string
): string {
  const primaryCanonical = primaryId ? canonicalLocalId(primaryId) : null;
  const resolved = deps
    .split(",")
    .map((dep) => dep.trim())
    .filter(Boolean)
    .flatMap((dep) => {
      const [type, targetId] = dep.split(":");
      if (!targetId) return [dep];
      if (isPlaceholderIssueRef(targetId)) {
        return [];
      }
      if (!isPlausibleIssueInput(targetId)) {
        return [];
      }
      if (primaryCanonical && canonicalLocalId(targetId) === primaryCanonical) {
        return [];
      }
      referencedIds.add(targetId);
      const resolvedTarget = resolveRemoteIssueId(targetId);
      if (isLocalId(targetId) && resolvedTarget === targetId) {
        const canonical = canonicalLocalId(targetId);
        if (isOrphanUnresolvedLocalId(canonical, context)) {
          // Drop orphaned LOCAL references from deps instead of deadlocking the outbox.
          return [];
        }
        unresolvedLocalIds.add(canonical);
        return [dep];
      }
      return [`${type}:${resolvedTarget}`];
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

function resolveOutboxItem(item: OutboxItem, context: ResolutionContext): ResolutionResult {
  const payload = { ...(item.payload as Record<string, unknown>) };
  const unresolvedLocalIds = new Set<string>();
  const referencedIds = new Set<string>();
  const primaryId = getPrimaryId(item);
  let dropOperation = false;

  const resolveField = (
    key: string,
    options: { dropFieldIfOrphan?: boolean; dropOperationIfOrphan?: boolean } = {}
  ): void => {
    const value = payload[key];
    if (typeof value !== "string") return;
    if (isPlaceholderIssueRef(value)) {
      if (options.dropFieldIfOrphan) {
        delete payload[key];
        return;
      }
      if (options.dropOperationIfOrphan) {
        dropOperation = true;
      }
      return;
    }
    if (options.dropFieldIfOrphan && !isPlausibleIssueInput(value)) {
      delete payload[key];
      return;
    }
    referencedIds.add(value);
    const resolvedValue = resolveRemoteIssueId(value);
    if (isLocalId(value) && resolvedValue === value) {
      const canonical = canonicalLocalId(value);
      if (isOrphanUnresolvedLocalId(canonical, context)) {
        if (options.dropFieldIfOrphan) {
          delete payload[key];
          return;
        }
        if (options.dropOperationIfOrphan) {
          dropOperation = true;
          return;
        }
      }
      unresolvedLocalIds.add(canonical);
      return;
    }
    payload[key] = resolvedValue;
  };

  switch (item.operation) {
    case "create": {
      if (typeof payload.description === "string") {
        payload.description = toCanonicalLocalDescription(payload.description);
      }
      resolveField("parentId", { dropFieldIfOrphan: true });
      if (
        typeof payload.parentId === "string" &&
        primaryId &&
        isSameCanonicalIssue(primaryId, payload.parentId)
      ) {
        delete payload.parentId;
      }
      if (typeof payload.deps === "string") {
        payload.deps = resolveDepsString(
          payload.deps,
          unresolvedLocalIds,
          referencedIds,
          context,
          primaryId
        );
        if (!payload.deps) {
          delete payload.deps;
        }
      }
      break;
    }
    case "update": {
      if (typeof payload.description === "string") {
        payload.description = toCanonicalLocalDescription(payload.description);
      }
      resolveField("issueId", { dropOperationIfOrphan: true });
      resolveField("parentId", { dropFieldIfOrphan: true });
      if (
        typeof payload.parentId === "string" &&
        typeof payload.issueId === "string" &&
        isSameCanonicalIssue(payload.issueId, payload.parentId)
      ) {
        delete payload.parentId;
      }
      if (typeof payload.deps === "string") {
        payload.deps = resolveDepsString(
          payload.deps,
          unresolvedLocalIds,
          referencedIds,
          context,
          typeof payload.issueId === "string" ? payload.issueId : primaryId
        );
        if (!payload.deps) {
          delete payload.deps;
        }
      }
      break;
    }
    case "close":
    case "delete": {
      resolveField("issueId", { dropOperationIfOrphan: true });
      break;
    }
    case "create_relation": {
      resolveField("issueId", { dropOperationIfOrphan: true });
      resolveField("relatedIssueId", { dropOperationIfOrphan: true });
      if (
        typeof payload.issueId === "string" &&
        typeof payload.relatedIssueId === "string" &&
        isSameCanonicalIssue(payload.issueId, payload.relatedIssueId)
      ) {
        dropOperation = true;
      }
      break;
    }
    case "delete_relation": {
      resolveField("issueA", { dropOperationIfOrphan: true });
      resolveField("issueB", { dropOperationIfOrphan: true });
      if (
        typeof payload.issueA === "string" &&
        typeof payload.issueB === "string" &&
        isSameCanonicalIssue(payload.issueA, payload.issueB)
      ) {
        dropOperation = true;
      }
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

  if (dropOperation) {
    return {
      canProcess: true,
      dropOperation: true,
      primaryId,
      referencedIds: [...referencedIds],
      unresolvedLocalIds: [...unresolvedLocalIds],
      resolvedPayload: payload,
    };
  }

  if (unresolvedLocalIds.size > 0) {
    return {
      canProcess: false,
      dropOperation: false,
      primaryId,
      referencedIds: [...referencedIds],
      unresolvedLocalIds: [...unresolvedLocalIds],
    };
  }

  return {
    canProcess: true,
    dropOperation: false,
    primaryId,
    referencedIds: [...referencedIds],
    unresolvedLocalIds: [...unresolvedLocalIds],
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
  } else if (isTerminalStatus(newStatus)) {
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
        syncKey?: string;
      };
      let remoteIssueIdentifier = item.remote_issue_identifier || getIssueIdMapping(localId);
      let remoteIssueUuid = getLinearIdForLocalId(resolveIssueLocalId(localId)) || undefined;
      let usedRemoteBackend = false;
      const syncKey =
        (typeof createPayload.syncKey === "string" && createPayload.syncKey.trim()) ||
        getIssueSyncKey(localId) ||
        ensureIssueSyncKey(localId);

      if (!remoteIssueIdentifier) {
        const cachedBySyncKey = getSyncedIssueBySyncKey(syncKey);
        if (cachedBySyncKey?.linear_identifier) {
          remoteIssueIdentifier = cachedBySyncKey.linear_identifier;
          remoteIssueUuid = cachedBySyncKey.linear_id || undefined;
        }
      }

      if (!remoteIssueIdentifier) {
        const remoteBySyncKey = await findIssueBySyncKey(teamId, syncKey);
        if (remoteBySyncKey?.linear_identifier) {
          remoteIssueIdentifier = remoteBySyncKey.linear_identifier;
          remoteIssueUuid = remoteBySyncKey.linear_id;
          usedRemoteBackend = true;
        }
      }

      if (!remoteIssueIdentifier) {
        const issue = await createIssue({
          title: createPayload.title,
          description: createPayload.description,
          priority: createPayload.priority,
          issueType: createPayload.issueType,
          parentId: createPayload.parentId,
          teamId,
          syncKey,
          skipCache: true,
        });
        remoteIssueIdentifier = issue.id;
        remoteIssueUuid = issue.linear_id;
        markOutboxCreateRemoteIssueIdentifier(item.id, remoteIssueIdentifier);
        usedRemoteBackend = true;
      }

      replaceIssueId(localId, remoteIssueIdentifier, remoteIssueUuid);

      if (createPayload.deps) {
        const deps = createPayload.deps.split(",").map((dep: string) => {
          const [type, targetId] = dep.trim().split(":");
          return { type, targetId };
        });
        const createdIssueRef = remoteIssueIdentifier;
        for (const dep of deps) {
          try {
            if (dep.type === "blocked-by") {
              await createRelation(dep.targetId, createdIssueRef, "blocks");
            } else {
              const relationType = dep.type === "blocks" ? "blocks" : "related";
              await createRelation(
                createdIssueRef,
                dep.targetId,
                relationType as "blocks" | "related"
              );
            }
          } catch {
            if (dep.type === "blocked-by") {
              queueRelationRetry(dep.targetId, createdIssueRef, "blocks");
            } else {
              const relationType = dep.type === "blocks" ? "blocks" : "related";
              queueRelationRetry(
                createdIssueRef,
                dep.targetId,
                relationType as "blocks" | "related"
              );
            }
          }
        }
      }
      return { usedRemoteBackend };
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
            if (dep.type === "blocked-by") {
              queueRelationRetry(dep.targetId, updatePayload.issueId, "blocks");
            } else {
              const relationType = dep.type === "blocks" ? "blocks" : "related";
              queueRelationRetry(
                updatePayload.issueId,
                dep.targetId,
                relationType as "blocks" | "related"
              );
            }
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
        relationType?: "blocks" | "related";
      };
      await deleteRelation(relPayload.issueA, relPayload.issueB, relPayload.relationType);
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

export function getOutboxItemEndpointNames(item: OutboxItem): string[] {
  const payload = item.payload as Record<string, unknown>;
  switch (item.operation) {
    case "create":
      return payloadReferencesMedia(payload)
        ? ["issueCreate", "issues", "issue", "uploads"]
        : ["issueCreate", "issues", "issue"];
    case "update":
      return payloadReferencesMedia(payload)
        ? ["issueUpdate", "issue", "issueRelationCreate", "uploads"]
        : ["issueUpdate", "issue", "issueRelationCreate"];
    case "close":
      return ["issueUpdate", "issue", "commentCreate"];
    case "delete":
      return ["issueDelete"];
    case "create_relation":
      return ["issue", "issueRelationCreate"];
    case "delete_relation":
      return ["issue", "issueRelationDelete"];
    case "mail_send":
    case "mail_reply":
      return getMailBackendAdapter().name === "linear" ? ["commentCreate"] : [];
    case "mail_mark_read":
    case "mail_ack":
      return [];
  }
}

function isPermanentEntityError(errorMessage: string): boolean {
  const msg = errorMessage.toLowerCase();
  return msg.includes("entity not found") || msg.includes("entity is trashed");
}

export async function processOutboxQueue(
  teamId: string,
  options: { propagateParent?: boolean } = {}
): Promise<{ success: number; failed: number; deferred: number; remoteProcessed: number }> {
  repairSelfReferentialDependencies();
  const items = getPendingOutboxItems();
  const pendingCreateLocalIds = new Set(
    items
      .filter((item) => item.operation === "create" && typeof item.local_id === "string")
      .map((item) => canonicalLocalId(item.local_id as string))
  );
  const resolutionContext: ResolutionContext = { pendingCreateLocalIds };
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

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.operation === "create" && item.local_id) {
      const localIssue = getCachedIssue(item.local_id);
      if (!localIssue && !reviveIssueFromCreateOutbox(item)) {
        // Keep the outbox row intact when the create payload is all we have left.
        deferred++;
        continue;
      }
      if (!getCachedIssue(item.local_id)) {
        removeOutboxItem(item.id);
        success++;
        continue;
      }
    }

    if (getAutomaticRemoteSyncPauseForEndpoints(getOutboxItemEndpointNames(item))) {
      deferred++;
      continue;
    }

    const resolution = resolveOutboxItem(item, resolutionContext);

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

    const claimedResolution = resolveOutboxItem(item, resolutionContext);
    if (claimedResolution.dropOperation) {
      removeOutboxItem(item.id);
      success++;
      continue;
    }
    if (!claimedResolution.canProcess || !claimedResolution.resolvedPayload) {
      releaseOutboxItemClaim(item.id);
      const unresolvedLocals = new Set(claimedResolution.unresolvedLocalIds.map(canonicalLocalId));
      if (claimedResolution.primaryId) {
        const primaryLocalId = canonicalLocalId(claimedResolution.primaryId);
        if (shouldBlockUnresolvedLocalId(primaryLocalId, pendingCreateLocalIds)) {
          addBlockedId(claimedResolution.primaryId);
        }
      }
      for (const localId of unresolvedLocals) {
        if (!shouldBlockUnresolvedLocalId(localId, pendingCreateLocalIds)) {
          continue;
        }
        addBlockedId(localId);
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
      if (isPermanentEntityError(errorMsg) && item.operation !== "create") {
        // Legacy queue rows can reference deleted/trashed entities forever.
        // Drop these rows so sync converges instead of retrying indefinitely.
        removeOutboxItem(item.id);
        success++;
        continue;
      }
      const pause = recordRemoteSyncPause(error);
      updateOutboxItemError(item.id, errorMsg, {
        retryAfterMs: pause?.retryAfterMs,
        rateLimited: pause?.kind === "rate_limit",
      });
      failed++;
    }
  }

  return { success, failed, deferred, remoteProcessed };
}
