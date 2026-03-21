import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseLinearMailEnvelopeFromComment,
  parseLinearMailDirectoryEntryFromComment,
  refreshLinearMailAgentDirectory,
  resolveLinearMailAgentByHandle,
  serializeLinearMailEnvelope,
  serializeLinearMailDirectoryEntry,
  type LinearMailEnvelope,
} from "../src/adapters/linear-mail.js";
import { getAgentByHandle, closeDatabase } from "../src/utils/database.js";
import { reloadConfig } from "../src/utils/config.js";
import { resetGraphQLClient } from "../src/utils/graphql.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
  });
}

function createTempGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (init.exitCode !== 0) {
    throw new Error("Failed to initialize temp git repo");
  }

  return dir;
}

function writeRepoConfig(repoDir: string, config: Record<string, unknown>): void {
  const lbDir = join(repoDir, ".lb");
  mkdirSync(lbDir, { recursive: true });
  writeFileSync(join(lbDir, "config.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
}

describe("linear mail adapter envelope", () => {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.LINEAR_API_KEY;
  let tempDir: string | null = null;

  beforeEach(() => {
    resetGraphQLClient();
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    resetGraphQLClient();
    process.chdir(originalCwd);
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.LINEAR_API_KEY;
    } else {
      process.env.LINEAR_API_KEY = originalApiKey;
    }
    reloadConfig();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("serializes and parses envelope with body", () => {
    const envelope: LinearMailEnvelope = {
      msg_id: "msg-1",
      thread_id: "thr-1",
      from: "AlphaAgent",
      from_agent_id: "agent-1",
      to: ["BetaAgent", "GammaAgent"],
      created_at: "2026-01-01T00:00:00.000Z",
      reply_to: "msg-0",
      subject: "Subject",
      body_md: "hello world",
    };

    const body = `${serializeLinearMailEnvelope(envelope)}\n\nhello world`;
    const parsed = parseLinearMailEnvelopeFromComment(body);

    expect(parsed).not.toBeNull();
    expect(parsed?.envelope.msg_id).toBe("msg-1");
    expect(parsed?.envelope.thread_id).toBe("thr-1");
    expect(parsed?.envelope.from).toBe("AlphaAgent");
    expect(parsed?.envelope.from_agent_id).toBe("agent-1");
    expect(parsed?.envelope.to).toEqual(["BetaAgent", "GammaAgent"]);
    expect(parsed?.envelope.reply_to).toBe("msg-0");
    expect(parsed?.envelope.subject).toBe("Subject");
    expect(parsed?.bodyMd).toBe("hello world");
  });

  test("returns null for malformed envelope payload", () => {
    const parsed = parseLinearMailEnvelopeFromComment(
      "<!-- lb-mail-envelope:v1 not-base64 -->\n\nbody"
    );
    expect(parsed).toBeNull();
  });

  test("returns null when required fields are missing", () => {
    const malformed = Buffer.from(
      JSON.stringify({ msg_id: "x", thread_id: "t", from: "a", to: [] }),
      "utf8"
    ).toString("base64");

    const parsed = parseLinearMailEnvelopeFromComment(
      `<!-- lb-mail-envelope:v1 ${malformed} -->\n\nbody`
    );
    expect(parsed).toBeNull();
  });

  test("serializes and parses a shared directory entry", () => {
    const body = serializeLinearMailDirectoryEntry({
      agent_id: "agent-remote-1",
      handle: "RemoteAlpha",
      display_name: "Remote Alpha",
      pubkey: "pubkey-1",
      registered_at: "2026-03-21T08:00:00.000Z",
    });

    expect(parseLinearMailDirectoryEntryFromComment(body)).toEqual({
      agent_id: "agent-remote-1",
      handle: "RemoteAlpha",
      display_name: "Remote Alpha",
      pubkey: "pubkey-1",
      registered_at: "2026-03-21T08:00:00.000Z",
    });
  });

  test("refreshes shared directory entries into the local cache", async () => {
    tempDir = createTempGitRepo("lb-linear-mail-directory");
    process.chdir(tempDir);
    writeRepoConfig(tempDir, {
      issue_backend: "linear",
      mail_backend: "linear",
      mail_registry_work_item: "linear:LIN-REG-1",
    });
    process.env.LINEAR_API_KEY = "test-linear-api-key";
    reloadConfig();

    const remoteAlpha = serializeLinearMailDirectoryEntry({
      agent_id: "agent-remote-1",
      handle: "RemoteAlpha",
      registered_at: "2026-03-21T08:00:00.000Z",
    });
    const remoteBeta = serializeLinearMailDirectoryEntry({
      agent_id: "agent-remote-2",
      handle: "RemoteBeta",
      registered_at: "2026-03-21T08:05:00.000Z",
    });

    globalThis.fetch = (async (_input, init) => {
      const payload = JSON.parse(String(init?.body || "{}")) as {
        query?: string;
      };

      if (payload.query?.includes("query GetIssue")) {
        return jsonResponse({ data: { issue: { id: "issue-registry-uuid" } } });
      }

      if (payload.query?.includes("query LinearIssueComments")) {
        return jsonResponse({
          data: {
            issue: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "comment-1",
                    body: remoteAlpha,
                    createdAt: "2026-03-21T08:00:00.000Z",
                    updatedAt: "2026-03-21T08:00:00.000Z",
                    issue: { identifier: "LIN-REG-1" },
                  },
                  {
                    id: "comment-2",
                    body: remoteBeta,
                    createdAt: "2026-03-21T08:05:00.000Z",
                    updatedAt: "2026-03-21T08:05:00.000Z",
                    issue: { identifier: "LIN-REG-1" },
                  },
                ],
              },
            },
          },
        });
      }

      throw new Error(`Unexpected GraphQL query: ${payload.query}`);
    }) as typeof fetch;

    const agents = await refreshLinearMailAgentDirectory();

    expect(agents.map((agent) => agent.handle)).toEqual(["RemoteAlpha", "RemoteBeta"]);
    expect(getAgentByHandle("RemoteAlpha")).toMatchObject({
      id: "agent-remote-1",
      handle: "RemoteAlpha",
      source: "shared",
    });
    expect(getAgentByHandle("RemoteBeta")).toMatchObject({
      id: "agent-remote-2",
      handle: "RemoteBeta",
      source: "shared",
    });
  });

  test("resolves an unknown handle through the shared directory", async () => {
    tempDir = createTempGitRepo("lb-linear-mail-lookup");
    process.chdir(tempDir);
    writeRepoConfig(tempDir, {
      issue_backend: "linear",
      mail_backend: "linear",
      mail_registry_work_item: "linear:LIN-REG-1",
    });
    process.env.LINEAR_API_KEY = "test-linear-api-key";
    reloadConfig();

    const remoteAlpha = serializeLinearMailDirectoryEntry({
      agent_id: "agent-remote-1",
      handle: "RemoteAlpha",
      registered_at: "2026-03-21T08:00:00.000Z",
    });

    globalThis.fetch = (async (_input, init) => {
      const payload = JSON.parse(String(init?.body || "{}")) as {
        query?: string;
      };

      if (payload.query?.includes("query GetIssue")) {
        return jsonResponse({ data: { issue: { id: "issue-registry-uuid" } } });
      }

      if (payload.query?.includes("query LinearIssueComments")) {
        return jsonResponse({
          data: {
            issue: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "comment-1",
                    body: remoteAlpha,
                    createdAt: "2026-03-21T08:00:00.000Z",
                    updatedAt: "2026-03-21T08:00:00.000Z",
                    issue: { identifier: "LIN-REG-1" },
                  },
                ],
              },
            },
          },
        });
      }

      throw new Error(`Unexpected GraphQL query: ${payload.query}`);
    }) as typeof fetch;

    const resolved = await resolveLinearMailAgentByHandle("RemoteAlpha");

    expect(resolved).toMatchObject({
      id: "agent-remote-1",
      handle: "RemoteAlpha",
      source: "shared",
    });
    expect(getAgentByHandle("RemoteAlpha")?.id).toBe("agent-remote-1");
  });
});
