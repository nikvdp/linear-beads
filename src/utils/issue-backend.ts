import type { IssueBackendAdapter } from "../adapters/types.js";
import * as linear from "./linear.js";
import { getIssueBackendKind, isLocalOnly } from "./config.js";

const linearIssueBackend: IssueBackendAdapter = {
  name: "linear",
  getTeamId: linear.getTeamId,
  verifyConnection: linear.verifyConnection,
  getViewer: linear.getViewer,
  getUserByEmail: linear.getUserByEmail,
  ensureRepoLabel: linear.ensureRepoLabel,
  ensureRepoProject: linear.ensureRepoProject,
  fetchIssues: linear.fetchIssues,
  fetchAllIssuesPaginated: linear.fetchAllIssuesPaginated,
  fetchAllUpdatedIssues: linear.fetchAllUpdatedIssues,
  fetchIssue: linear.fetchIssue,
  findIssueBySyncKey: linear.findIssueBySyncKey,
  createIssue: linear.createIssue,
  updateIssue: linear.updateIssue,
  updateIssueParent: linear.updateIssueParent,
  closeIssue: linear.closeIssue,
  deleteIssue: linear.deleteIssue,
  createRelation: linear.createRelation,
  deleteRelation: linear.deleteRelation,
  fetchIssueComments: linear.fetchIssueComments,
  addComment: linear.addComment,
};

function localIssueBackendError(action: string): Error {
  return new Error(`Issue backend 'local' does not support remote action: ${action}`);
}

const localIssueBackend: IssueBackendAdapter = {
  name: "local",
  async getTeamId() {
    throw localIssueBackendError("getTeamId");
  },
  async verifyConnection() {
    throw localIssueBackendError("verifyConnection");
  },
  async getViewer() {
    throw localIssueBackendError("getViewer");
  },
  async getUserByEmail() {
    throw localIssueBackendError("getUserByEmail");
  },
  async ensureRepoLabel() {
    throw localIssueBackendError("ensureRepoLabel");
  },
  async ensureRepoProject() {
    throw localIssueBackendError("ensureRepoProject");
  },
  async fetchIssues() {
    throw localIssueBackendError("fetchIssues");
  },
  async fetchAllIssuesPaginated() {
    throw localIssueBackendError("fetchAllIssuesPaginated");
  },
  async fetchAllUpdatedIssues() {
    throw localIssueBackendError("fetchAllUpdatedIssues");
  },
  async fetchIssue() {
    throw localIssueBackendError("fetchIssue");
  },
  async findIssueBySyncKey() {
    throw localIssueBackendError("findIssueBySyncKey");
  },
  async createIssue() {
    throw localIssueBackendError("createIssue");
  },
  async updateIssue() {
    throw localIssueBackendError("updateIssue");
  },
  async updateIssueParent() {
    throw localIssueBackendError("updateIssueParent");
  },
  async closeIssue() {
    throw localIssueBackendError("closeIssue");
  },
  async deleteIssue() {
    throw localIssueBackendError("deleteIssue");
  },
  async createRelation(_issueId: string, _relatedIssueId: string, _type: "blocks" | "related") {
    throw localIssueBackendError("createRelation");
  },
  async deleteRelation(
    _issueId: string,
    _relatedIssueId: string,
    _relationType?: "blocks" | "related"
  ) {
    throw localIssueBackendError("deleteRelation");
  },
  async fetchIssueComments() {
    throw localIssueBackendError("fetchIssueComments");
  },
  async addComment() {
    throw localIssueBackendError("addComment");
  },
};

export function getIssueBackendAdapter(): IssueBackendAdapter {
  if (isLocalOnly()) {
    return localIssueBackend;
  }

  return getIssueBackendKind() === "local" ? localIssueBackend : linearIssueBackend;
}

export async function getTeamId(teamKey?: string): Promise<string> {
  return getIssueBackendAdapter().getTeamId(teamKey);
}

export async function verifyConnection(): ReturnType<IssueBackendAdapter["verifyConnection"]> {
  return getIssueBackendAdapter().verifyConnection();
}

export async function getViewer(): ReturnType<IssueBackendAdapter["getViewer"]> {
  return getIssueBackendAdapter().getViewer();
}

export async function getUserByEmail(
  email: string
): ReturnType<IssueBackendAdapter["getUserByEmail"]> {
  return getIssueBackendAdapter().getUserByEmail(email);
}

export async function ensureRepoLabel(
  teamId: string
): ReturnType<IssueBackendAdapter["ensureRepoLabel"]> {
  return getIssueBackendAdapter().ensureRepoLabel(teamId);
}

export async function ensureRepoProject(
  teamId: string
): ReturnType<IssueBackendAdapter["ensureRepoProject"]> {
  return getIssueBackendAdapter().ensureRepoProject(teamId);
}

export async function fetchIssues(teamId: string): ReturnType<IssueBackendAdapter["fetchIssues"]> {
  return getIssueBackendAdapter().fetchIssues(teamId);
}

export async function fetchAllIssuesPaginated(
  teamId: string
): ReturnType<IssueBackendAdapter["fetchAllIssuesPaginated"]> {
  return getIssueBackendAdapter().fetchAllIssuesPaginated(teamId);
}

export async function fetchAllUpdatedIssues(
  teamId: string,
  since: string
): ReturnType<IssueBackendAdapter["fetchAllUpdatedIssues"]> {
  return getIssueBackendAdapter().fetchAllUpdatedIssues(teamId, since);
}

export async function fetchIssue(issueId: string): ReturnType<IssueBackendAdapter["fetchIssue"]> {
  return getIssueBackendAdapter().fetchIssue(issueId);
}

export async function findIssueBySyncKey(
  teamId: string,
  syncKey: string
): ReturnType<IssueBackendAdapter["findIssueBySyncKey"]> {
  return getIssueBackendAdapter().findIssueBySyncKey(teamId, syncKey);
}

export async function createIssue(
  params: Parameters<IssueBackendAdapter["createIssue"]>[0]
): ReturnType<IssueBackendAdapter["createIssue"]> {
  return getIssueBackendAdapter().createIssue(params);
}

export async function updateIssue(
  issueId: Parameters<IssueBackendAdapter["updateIssue"]>[0],
  updates: Parameters<IssueBackendAdapter["updateIssue"]>[1],
  teamId: Parameters<IssueBackendAdapter["updateIssue"]>[2],
  options?: Parameters<IssueBackendAdapter["updateIssue"]>[3]
): ReturnType<IssueBackendAdapter["updateIssue"]> {
  return getIssueBackendAdapter().updateIssue(issueId, updates, teamId, options);
}

export async function updateIssueParent(
  issueId: string,
  parentId: string | null
): ReturnType<IssueBackendAdapter["updateIssueParent"]> {
  return getIssueBackendAdapter().updateIssueParent(issueId, parentId);
}

export async function closeIssue(
  issueId: string,
  teamId: string,
  reason?: string
): ReturnType<IssueBackendAdapter["closeIssue"]> {
  return getIssueBackendAdapter().closeIssue(issueId, teamId, reason);
}

export async function deleteIssue(issueId: string): ReturnType<IssueBackendAdapter["deleteIssue"]> {
  return getIssueBackendAdapter().deleteIssue(issueId);
}

export async function createRelation(
  issueId: string,
  relatedIssueId: string,
  type: "blocks" | "related"
): ReturnType<IssueBackendAdapter["createRelation"]> {
  return getIssueBackendAdapter().createRelation(issueId, relatedIssueId, type);
}

export async function deleteRelation(
  issueId: string,
  relatedIssueId: string,
  relationType?: "blocks" | "related"
): ReturnType<IssueBackendAdapter["deleteRelation"]> {
  return getIssueBackendAdapter().deleteRelation(issueId, relatedIssueId, relationType);
}

export async function fetchIssueComments(
  issueId: string
): ReturnType<IssueBackendAdapter["fetchIssueComments"]> {
  return getIssueBackendAdapter().fetchIssueComments(issueId);
}

export async function addComment(
  issueId: string,
  body: string,
  parentId?: string
): ReturnType<IssueBackendAdapter["addComment"]> {
  return getIssueBackendAdapter().addComment(issueId, body, parentId);
}
