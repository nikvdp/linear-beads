import { addComment } from "../utils/issue-backend.js";
import { getGraphQLClient } from "../utils/graphql.js";
import {
  getAgentByHandle,
  getAgentById,
  getMailMessageById,
  getMailSyncCursor,
  getMailThreadById,
  registerAgent,
  setMailSyncCursor,
  updateMailMessageSyncStatus,
  upsertMailMessageFromSync,
} from "../utils/database.js";
import type { MailBackendAdapter } from "./types.js";

const ENVELOPE_TAG = "lb-mail-envelope:v1";

export interface LinearMailEnvelope {
  msg_id: string;
  thread_id: string;
  from: string;
  to: string[];
  created_at: string;
  reply_to?: string;
  subject: string;
  body_md?: string;
}

interface ParsedEnvelope {
  envelope: LinearMailEnvelope;
  bodyMd: string;
}

interface LinearCommentNode {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  issue: { identifier: string } | null;
}

function resolveLinearIssueIdFromWorkItemRef(workItemRef?: string): string | null {
  if (!workItemRef) return null;
  if (!workItemRef.startsWith("linear:")) return null;
  const candidate = workItemRef.slice("linear:".length).trim();
  return candidate.length > 0 ? candidate : null;
}

function encodeEnvelope(envelope: LinearMailEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

function decodeEnvelope(encoded: string): LinearMailEnvelope | null {
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as Partial<LinearMailEnvelope>;
    if (
      !parsed ||
      typeof parsed.msg_id !== "string" ||
      typeof parsed.thread_id !== "string" ||
      typeof parsed.from !== "string" ||
      !Array.isArray(parsed.to) ||
      typeof parsed.created_at !== "string" ||
      typeof parsed.subject !== "string"
    ) {
      return null;
    }

    const recipients = parsed.to.filter((entry): entry is string => typeof entry === "string");
    if (recipients.length === 0) {
      return null;
    }

    return {
      msg_id: parsed.msg_id,
      thread_id: parsed.thread_id,
      from: parsed.from,
      to: recipients,
      created_at: parsed.created_at,
      reply_to: typeof parsed.reply_to === "string" ? parsed.reply_to : undefined,
      subject: parsed.subject,
      body_md: typeof parsed.body_md === "string" ? parsed.body_md : undefined,
    };
  } catch {
    return null;
  }
}

export function serializeLinearMailEnvelope(envelope: LinearMailEnvelope): string {
  return `<!-- ${ENVELOPE_TAG} ${encodeEnvelope(envelope)} -->`;
}

export function parseLinearMailEnvelopeFromComment(commentBody: string): ParsedEnvelope | null {
  const marker = `<!-- ${ENVELOPE_TAG} `;
  const start = commentBody.indexOf(marker);
  if (start < 0) return null;

  const encodedStart = start + marker.length;
  const end = commentBody.indexOf(" -->", encodedStart);
  if (end < 0) return null;

  const encoded = commentBody.slice(encodedStart, end).trim();
  if (!encoded) return null;

  const envelope = decodeEnvelope(encoded);
  if (!envelope) return null;

  const suffix = commentBody.slice(end + " -->".length).replace(/^\s+/, "");
  return {
    envelope,
    bodyMd: envelope.body_md || suffix,
  };
}

function ensureAgentByHandle(handle: string) {
  const existing = getAgentByHandle(handle);
  if (existing) return existing;
  return registerAgent({ preferredHandle: handle });
}

function buildOutboundEnvelope(messageId: string): {
  issueId: string;
  body: string;
} {
  const message = getMailMessageById(messageId);
  if (!message) {
    throw new Error(`Mail message not found: ${messageId}`);
  }

  const thread = getMailThreadById(message.thread_id);
  const issueId = resolveLinearIssueIdFromWorkItemRef(thread?.work_item_ref);
  if (!issueId) {
    throw new Error(`Thread ${message.thread_id} is missing linear work item mapping`);
  }

  const sender = getAgentById(message.sender_agent_id);
  const recipientHandles = message.recipients
    .map(
      (recipient) =>
        getAgentById(recipient.recipient_agent_id)?.handle || recipient.recipient_agent_id
    )
    .filter(Boolean);

  const envelope: LinearMailEnvelope = {
    msg_id: message.id,
    thread_id: message.thread_id,
    from: sender?.handle || message.sender_agent_id,
    to: recipientHandles,
    created_at: message.created_at,
    reply_to: message.reply_to_message_id,
    subject: message.subject,
    body_md: message.body_md,
  };

  const header = serializeLinearMailEnvelope(envelope);
  return {
    issueId,
    body: `${header}\n\n${message.body_md}`,
  };
}

async function projectMessage(messageId: string): Promise<void> {
  const outbound = buildOutboundEnvelope(messageId);
  await addComment(outbound.issueId, outbound.body);
  updateMailMessageSyncStatus(messageId, "synced");
}

async function fetchLinearMailComments(
  sinceCursor: string | null,
  limit: number
): Promise<{ comments: LinearCommentNode[]; newestCursor: string | null }> {
  const client = getGraphQLClient();
  const comments: LinearCommentNode[] = [];
  let after: string | null = null;
  let newestCursor: string | null = sinceCursor;

  while (comments.length < limit) {
    const query = `
      query LinearMailComments($after: String, $since: DateTimeOrDuration) {
        comments(
          first: 50,
          after: $after,
          orderBy: updatedAt,
          filter: { updatedAt: { gt: $since } }
        ) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            body
            createdAt
            updatedAt
            issue {
              identifier
            }
          }
        }
      }
    `;

    const result: {
      comments: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: LinearCommentNode[];
      };
    } = await client.request(query, {
      after,
      since: sinceCursor || "1970-01-01T00:00:00.000Z",
    });

    for (const node of result.comments.nodes) {
      comments.push(node);
      if (!newestCursor || node.updatedAt > newestCursor) {
        newestCursor = node.updatedAt;
      }
      if (comments.length >= limit) {
        break;
      }
    }

    if (!result.comments.pageInfo.hasNextPage || !result.comments.pageInfo.endCursor) {
      break;
    }
    after = result.comments.pageInfo.endCursor;
  }

  return {
    comments,
    newestCursor,
  };
}

async function ingestFromLinear(options?: { limit?: number }) {
  const limit = Math.max(1, Math.min(options?.limit || 200, 500));
  const cursor = getMailSyncCursor("linear");
  const { comments, newestCursor } = await fetchLinearMailComments(cursor, limit);

  let inserted = 0;
  let skipped = 0;

  for (const comment of comments) {
    const parsed = parseLinearMailEnvelopeFromComment(comment.body);
    if (!parsed || !comment.issue?.identifier) {
      skipped++;
      continue;
    }

    const sender = ensureAgentByHandle(parsed.envelope.from);
    const recipients = parsed.envelope.to.map((handle) => {
      const recipient = ensureAgentByHandle(handle);
      return { recipientAgentId: recipient.id, kind: "to" as const };
    });

    const result = upsertMailMessageFromSync({
      messageId: parsed.envelope.msg_id,
      threadId: parsed.envelope.thread_id,
      senderAgentId: sender.id,
      subject: parsed.envelope.subject,
      bodyMd: parsed.bodyMd,
      createdAt: parsed.envelope.created_at || comment.createdAt,
      replyToMessageId: parsed.envelope.reply_to,
      workItemRef: `linear:${comment.issue.identifier}`,
      recipients,
    });

    if (result.inserted) {
      inserted++;
    } else {
      skipped++;
    }
  }

  if (newestCursor) {
    setMailSyncCursor("linear", newestCursor);
  }

  return {
    inserted,
    skipped,
    cursor: newestCursor,
  };
}

export const linearMailBackend: MailBackendAdapter = {
  name: "linear",
  async send(messageId: string): Promise<void> {
    await projectMessage(messageId);
  },
  async reply(messageId: string): Promise<void> {
    await projectMessage(messageId);
  },
  async markRead(): Promise<void> {
    // read state projection lands in phase 2.3 pipeline integration
  },
  async ack(): Promise<void> {
    // ack projection lands in phase 2.3 pipeline integration
  },
  async ingest(options): Promise<{ inserted: number; skipped: number; cursor: string | null }> {
    return ingestFromLinear(options);
  },
};
