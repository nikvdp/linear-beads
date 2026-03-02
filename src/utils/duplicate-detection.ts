import type { Issue } from "../types.js";

export type DuplicateMatchReason = "exact_title" | "normalized_title" | "description_hash";

export interface DuplicateMatch {
  issue: Issue;
  reasons: DuplicateMatchReason[];
}

export interface DuplicateCluster {
  key: string;
  issues: Issue[];
  canonical: Issue;
  duplicates: Issue[];
}

function normalizeWhitespace(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~>#-]/g, " ");
}

export function normalizeTitle(title: string): string {
  return normalizeWhitespace(title);
}

export function normalizeDescription(description: string): string {
  return normalizeWhitespace(stripMarkdown(description));
}

function parseUpdatedAt(issue: Issue): number {
  const parsed = Date.parse(issue.updated_at);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function canonicalStatusRank(issue: Issue): number {
  if (issue.status === "in_progress") return 2;
  if (issue.status === "open") return 1;
  return 0;
}

function canonicalIssueSort(a: Issue, b: Issue): number {
  const rankDelta = canonicalStatusRank(b) - canonicalStatusRank(a);
  if (rankDelta !== 0) return rankDelta;
  return parseUpdatedAt(b) - parseUpdatedAt(a);
}

export function chooseCanonicalIssue(issues: Issue[]): Issue {
  const sorted = [...issues].sort(canonicalIssueSort);
  return sorted[0];
}

export function chooseReuseIssue(matches: DuplicateMatch[]): Issue {
  const open = matches
    .map((match) => match.issue)
    .filter((issue) => issue.status === "open")
    .sort((a, b) => parseUpdatedAt(b) - parseUpdatedAt(a));
  if (open.length > 0) {
    return open[0];
  }

  const sorted = matches
    .map((match) => match.issue)
    .sort((a, b) => parseUpdatedAt(b) - parseUpdatedAt(a));
  return sorted[0];
}

export function findDuplicateMatches(
  issues: Issue[],
  title: string,
  description?: string
): DuplicateMatch[] {
  const exactTitle = title.trim();
  const normalizedTitle = normalizeTitle(title);
  const normalizedDescription = description ? normalizeDescription(description) : "";

  const matches: DuplicateMatch[] = [];

  for (const issue of issues) {
    const reasons: DuplicateMatchReason[] = [];

    if (issue.title.trim() === exactTitle) {
      reasons.push("exact_title");
    }

    if (normalizeTitle(issue.title) === normalizedTitle) {
      reasons.push("normalized_title");
    }

    if (normalizedDescription && issue.description) {
      if (normalizeDescription(issue.description) === normalizedDescription) {
        reasons.push("description_hash");
      }
    }

    if (reasons.length > 0) {
      matches.push({ issue, reasons });
    }
  }

  return matches.sort((a, b) => canonicalIssueSort(a.issue, b.issue));
}

export function buildTitleDuplicateClusters(issues: Issue[]): DuplicateCluster[] {
  const byTitle = new Map<string, Issue[]>();
  for (const issue of issues) {
    const key = normalizeTitle(issue.title);
    if (!key) continue;
    const existing = byTitle.get(key);
    if (existing) {
      existing.push(issue);
    } else {
      byTitle.set(key, [issue]);
    }
  }

  const clusters: DuplicateCluster[] = [];
  for (const [key, clusterIssues] of byTitle.entries()) {
    if (clusterIssues.length < 2) {
      continue;
    }
    const canonical = chooseCanonicalIssue(clusterIssues);
    const duplicates = clusterIssues.filter((issue) => issue.id !== canonical.id);
    clusters.push({
      key,
      issues: clusterIssues,
      canonical,
      duplicates,
    });
  }

  return clusters.sort((a, b) => canonicalIssueSort(a.canonical, b.canonical));
}
