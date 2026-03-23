import { Command } from "commander";
import {
  isLinearMailDirectoryConfigured,
  resolveLinearMailAgentByHandle,
} from "../adapters/linear-mail.js";
import {
  ackMessage,
  fetchInbox,
  fetchThread,
  getAgentByHandle,
  getCurrentAgentHandle,
  getMailMessageById,
  listAgents,
  markMessageRead,
  queueOutboxItem,
  storeMessage,
} from "../utils/database.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";
import { output, outputError } from "../utils/output.js";
import { getMailBackendKind } from "../utils/config.js";
import { resolveAtFileText } from "../utils/description-input.js";
import type { MailRecipientKind } from "../types.js";

function splitHandles(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function requireAgentByHandle(handle: string) {
  const agent = getAgentByHandle(handle);
  if (!agent) {
    outputError(`Unknown agent handle: ${handle}`);
    process.exit(1);
  }
  return agent;
}

function resolveSender(optionsFrom?: string) {
  const senderHandle = optionsFrom || getCurrentAgentHandle();
  if (!senderHandle) {
    outputError("Sender handle is required. Provide --from or run `lb agent register` first.");
    process.exit(1);
  }
  return requireAgentByHandle(senderHandle);
}

async function resolveAgentHandleForSend(handle: string) {
  const local = getAgentByHandle(handle);
  if (local) {
    return local;
  }

  if (getMailBackendKind() === "linear") {
    const shared = await resolveLinearMailAgentByHandle(handle);
    if (shared) {
      return shared;
    }

    if (!isLinearMailDirectoryConfigured()) {
      outputError(
        `Unknown agent handle: ${handle}. Cross-client mail lookup requires mail_registry_work_item in .lb/config.jsonc.`
      );
      process.exit(1);
    }
  }

  outputError(`Unknown agent handle: ${handle}`);
  process.exit(1);
}

async function resolveRecipients(handles: string[], kind: MailRecipientKind = "to") {
  const seen = new Set<string>();
  const recipients: Array<{ recipientAgentId: string; kind: MailRecipientKind }> = [];

  for (const handle of handles) {
    const agent = await resolveAgentHandleForSend(handle);
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    recipients.push({ recipientAgentId: agent.id, kind });
  }

  return recipients;
}

function enrichWithHandles() {
  const map = new Map(listAgents().map((agent) => [agent.id, agent.handle]));
  return (agentId: string) => map.get(agentId) || agentId;
}

export const mailCommand = new Command("mail").description(
  "Local mail operations between registered agents"
);

mailCommand
  .command("send")
  .description("Send a local mail message")
  .requiredOption("--to <handles>", "Comma-separated recipient handles")
  .requiredOption("--subject <subject>", "Message subject")
  .requiredOption("--body <markdown>", "Markdown body; prefix with @ to read from file")
  .option("--from <handle>", "Sender handle")
  .option("--thread <threadId>", "Existing thread ID")
  .option("--work-item <ref>", "Optional linked work item ref, e.g. linear:LIN-123")
  .option("-j, --json", "Output as JSON")
  .action(async (options) => {
    const sender = resolveSender(options.from);
    const body = await resolveAtFileText(options.body);
    const toHandles = splitHandles(options.to);
    if (toHandles.length === 0) {
      outputError("At least one recipient handle is required.");
      process.exit(1);
    }

    const recipients = (await resolveRecipients(toHandles, "to")).filter(
      (recipient) => recipient.recipientAgentId !== sender.id
    );
    if (recipients.length === 0) {
      outputError("Message requires at least one recipient other than the sender.");
      process.exit(1);
    }

    const result = storeMessage({
      threadId: options.thread,
      senderAgentId: sender.id,
      subject: options.subject,
      bodyMd: body,
      recipients,
      workItemRef: options.workItem,
      syncStatus: "pending",
    });
    queueOutboxItem("mail_send", {
      messageId: result.message.id,
      threadId: result.thread.id,
      senderAgentId: sender.id,
    });
    ensureOutboxProcessed();

    if (options.json) {
      output(JSON.stringify(result, null, 2));
    } else {
      output(`Sent ${result.message.id} on thread ${result.thread.id}`);
    }
  });

mailCommand
  .command("inbox")
  .description("Fetch a local inbox for an agent")
  .option("--agent <handle>", "Agent handle (defaults to current)")
  .option("--unread", "Show unread only")
  .option("--since <iso>", "Only messages after this ISO timestamp")
  .option("--limit <n>", "Max messages", "20")
  .option("-j, --json", "Output as JSON")
  .action((options) => {
    const agent = resolveSender(options.agent);
    const limit = Number.parseInt(options.limit, 10);

    const items = fetchInbox(agent.id, {
      unreadOnly: !!options.unread,
      since: options.since,
      limit: Number.isFinite(limit) ? limit : 20,
    });

    const toHandle = enrichWithHandles();
    const payload = items.map((item) => ({
      ...item,
      message: {
        ...item.message,
        sender_handle: toHandle(item.message.sender_agent_id),
      },
      recipient: {
        ...item.recipient,
        recipient_handle: toHandle(item.recipient.recipient_agent_id),
      },
    }));

    if (options.json) {
      output(JSON.stringify(payload, null, 2));
      return;
    }

    if (payload.length === 0) {
      output("Inbox is empty.");
      return;
    }

    for (const item of payload) {
      output(
        `${item.message.id} [${item.message.sender_handle}] ${item.message.subject} (${item.message.created_at})`
      );
    }
  });

mailCommand
  .command("read")
  .description("Mark a message as read for an agent")
  .requiredOption("--message <id>", "Message ID")
  .option("--agent <handle>", "Agent handle (defaults to current)")
  .option("-j, --json", "Output as JSON")
  .action((options) => {
    const agent = resolveSender(options.agent);
    const result = markMessageRead(agent.id, options.message);
    if (result.updated === 0) {
      outputError("Message not found for this recipient.");
      process.exit(1);
    }
    queueOutboxItem("mail_mark_read", {
      messageId: options.message,
      recipientAgentId: agent.id,
    });
    ensureOutboxProcessed();

    if (options.json) {
      output(JSON.stringify(result, null, 2));
    } else {
      output(`Read ${result.messageId}`);
    }
  });

mailCommand
  .command("ack")
  .description("Acknowledge a message for an agent")
  .requiredOption("--message <id>", "Message ID")
  .option("--agent <handle>", "Agent handle (defaults to current)")
  .option("-j, --json", "Output as JSON")
  .action((options) => {
    const agent = resolveSender(options.agent);
    const result = ackMessage(agent.id, options.message);
    if (result.updated === 0) {
      outputError("Message not found for this recipient.");
      process.exit(1);
    }
    queueOutboxItem("mail_ack", {
      messageId: options.message,
      recipientAgentId: agent.id,
    });
    ensureOutboxProcessed();

    if (options.json) {
      output(JSON.stringify(result, null, 2));
    } else {
      output(`Acknowledged ${result.messageId}`);
    }
  });

mailCommand
  .command("reply")
  .description("Reply to an existing message")
  .requiredOption("--message <id>", "Message ID to reply to")
  .requiredOption("--body <markdown>", "Reply body; prefix with @ to read from file")
  .option("--agent <handle>", "Sender handle (defaults to current)")
  .option("-j, --json", "Output as JSON")
  .action(async (options) => {
    const sender = resolveSender(options.agent);
    const body = await resolveAtFileText(options.body);
    const parent = getMailMessageById(options.message);
    if (!parent) {
      outputError(`Message not found: ${options.message}`);
      process.exit(1);
    }

    const recipientIds = new Set<string>();
    recipientIds.add(parent.sender_agent_id);
    for (const recipient of parent.recipients) {
      recipientIds.add(recipient.recipient_agent_id);
    }
    recipientIds.delete(sender.id);

    if (recipientIds.size === 0) {
      outputError("Reply has no eligible recipients.");
      process.exit(1);
    }

    const subject = /^Re:/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`;
    const result = storeMessage({
      threadId: parent.thread_id,
      senderAgentId: sender.id,
      subject,
      bodyMd: body,
      replyToMessageId: parent.id,
      syncStatus: "pending",
      recipients: [...recipientIds].map((id) => ({ recipientAgentId: id, kind: "to" as const })),
    });
    queueOutboxItem("mail_reply", {
      messageId: result.message.id,
      replyToMessageId: parent.id,
      threadId: result.thread.id,
      senderAgentId: sender.id,
    });
    ensureOutboxProcessed();

    if (options.json) {
      output(JSON.stringify(result, null, 2));
    } else {
      output(`Replied with ${result.message.id} on thread ${result.thread.id}`);
    }
  });

mailCommand
  .command("thread")
  .description("Show messages in a thread")
  .requiredOption("--thread <id>", "Thread ID")
  .option("-j, --json", "Output as JSON")
  .action((options) => {
    const result = fetchThread(options.thread);
    if (!result.thread) {
      outputError(`Thread not found: ${options.thread}`);
      process.exit(1);
    }

    const toHandle = enrichWithHandles();
    const payload = {
      thread: result.thread,
      messages: result.messages.map((message) => ({
        ...message,
        sender_handle: toHandle(message.sender_agent_id),
        recipients: message.recipients.map((recipient) => ({
          ...recipient,
          recipient_handle: toHandle(recipient.recipient_agent_id),
        })),
      })),
    };

    if (options.json) {
      output(JSON.stringify(payload, null, 2));
      return;
    }

    output(`Thread ${payload.thread.id}: ${payload.thread.subject || "(no subject)"}`);
    for (const message of payload.messages) {
      output(`${message.id} [${message.sender_handle}] ${message.subject}`);
    }
  });
