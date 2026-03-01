import type { Issue, IssueType, Priority, IssueStatus } from "../types.js";

export interface IssueBackendAdapter {
  readonly name: string;
  getTeamId(teamKey?: string): Promise<string>;
  verifyConnection(): Promise<{
    userId: string;
    userName: string;
    teams: Array<{ id: string; key: string; name: string }>;
  }>;
  getViewer(): Promise<{ id: string; email: string; name: string }>;
  getUserByEmail(email: string): Promise<{ id: string; email: string; name: string } | null>;
  ensureRepoLabel(teamId: string): Promise<string>;
  ensureRepoProject(teamId: string): Promise<string>;
  fetchIssues(teamId: string): Promise<Issue[]>;
  fetchAllIssuesPaginated(teamId: string): Promise<{ issues: Issue[]; pruned: number }>;
  fetchAllUpdatedIssues(teamId: string, since: string): Promise<Issue[]>;
  fetchIssue(issueId: string): Promise<Issue | null>;
  createIssue(params: {
    title: string;
    description?: string;
    priority: Priority;
    issueType?: IssueType;
    teamId: string;
    parentId?: string;
    assigneeId?: string;
    status?: IssueStatus;
  }): Promise<Issue>;
  updateIssue(
    issueId: string,
    updates: {
      title?: string;
      description?: string;
      status?: IssueStatus;
      priority?: Priority;
      assigneeId?: string | null;
    },
    teamId: string
  ): Promise<Issue>;
  updateIssueParent(issueId: string, parentId: string | null): Promise<void>;
  closeIssue(issueId: string, teamId: string, reason?: string): Promise<Issue>;
  deleteIssue(issueId: string): Promise<void>;
  createRelation(
    issueId: string,
    relatedIssueId: string,
    type: "blocks" | "related"
  ): Promise<void>;
  deleteRelation(issueId: string, relatedIssueId: string): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
}

export interface MailBackendAdapter {
  readonly name: string;
  send(messageId: string): Promise<void>;
  reply(messageId: string): Promise<void>;
  markRead(messageId: string, recipientAgentId: string): Promise<void>;
  ack(messageId: string, recipientAgentId: string): Promise<void>;
  ingest(options?: {
    limit?: number;
  }): Promise<{ inserted: number; skipped: number; cursor: string | null }>;
}
