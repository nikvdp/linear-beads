/**
 * Output formatting utilities
 * Ensures bd-compatible JSON output
 */

import type { Issue, Dependency } from "../types.js";
import { listMediaItemsForIssue } from "./database.js";
import { renderDescriptionWithCanonicalMedia, renderIssueLinksAsPlainText } from "./linear.js";

export function normalizeIssueDescriptionForOutput(
  description: unknown,
  issueId?: string
): string | undefined {
  if (typeof description !== "string") {
    return undefined;
  }
  const withCanonicalMedia = renderDescriptionWithCanonicalMedia(description, issueId);
  return renderIssueLinksAsPlainText(withCanonicalMedia);
}

function issueWithPlainDescription(issue: Issue): Issue {
  const normalizedDescription = normalizeIssueDescriptionForOutput(
    (issue as { description?: unknown }).description,
    issue.local_id || issue.id
  );
  if (normalizedDescription === undefined) {
    return issue;
  }
  return {
    ...issue,
    description: normalizedDescription,
  };
}

/**
 * Format issues for JSON output (always returns array)
 */
export function formatIssuesJson(issues: Issue[]): string {
  return JSON.stringify(issues.map(issueWithPlainDescription), null, 2);
}

/**
 * Format single issue for JSON output (returns array with one element)
 */
export function formatIssueJson(issue: Issue): string {
  return JSON.stringify([issueWithPlainDescription(issue)], null, 2);
}

/**
 * Format issues with dependency counts for list output
 */
export function formatIssuesListJson(
  issues: Issue[],
  getDependencyCount: (id: string) => number,
  getDependentCount: (id: string) => number
): string {
  const formatted = issues.map((issue) => ({
    id: issue.id,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    // Only include issue_type if set
    ...(issue.issue_type ? { issue_type: issue.issue_type } : {}),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    // bd-style: only include assignee if non-null
    ...(issue.assignee ? { assignee: issue.assignee } : {}),
    dependency_count: getDependencyCount(issue.id),
    dependent_count: getDependentCount(issue.id),
  }));
  return JSON.stringify(formatted, null, 2);
}

/**
 * Format issues with dependencies for ready output
 */
export function formatReadyJson(
  issues: Issue[],
  getDependencies: (id: string) => Dependency[]
): string {
  const formatted = issues.map((issue) => ({
    id: issue.id,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    // Only include issue_type if set
    ...(issue.issue_type ? { issue_type: issue.issue_type } : {}),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    // bd-style: only include assignee if non-null
    ...(issue.assignee ? { assignee: issue.assignee } : {}),
    dependencies: getDependencies(issue.id),
  }));
  return JSON.stringify(formatted, null, 2);
}

/**
 * Format issue for show output (with description)
 */
export function formatShowJson(issue: Issue, dependencies?: Dependency[]): string {
  const plainIssue = issueWithPlainDescription(issue);
  const formatted = {
    id: plainIssue.id,
    title: plainIssue.title,
    description: plainIssue.description,
    status: plainIssue.status,
    priority: plainIssue.priority,
    // Only include issue_type if set
    ...(plainIssue.issue_type ? { issue_type: plainIssue.issue_type } : {}),
    created_at: plainIssue.created_at,
    updated_at: plainIssue.updated_at,
    closed_at: plainIssue.closed_at,
    // bd-style: only include assignee if non-null
    ...(plainIssue.assignee ? { assignee: plainIssue.assignee } : {}),
    ...(dependencies && dependencies.length > 0 ? { dependencies } : {}),
  };
  return JSON.stringify([formatted], null, 2);
}

/**
 * Priority display (matches bd)
 */
const PRIORITY_LABELS: Record<number, string> = {
  0: "critical",
  1: "high",
  2: "medium",
  3: "low",
  4: "backlog",
};

const BEADS_PRIORITY_LABELS = ["P0", "P1", "P2", "P3", "P4"] as const;
const STATUS_SYMBOLS = {
  backlog: "◌",
  open: "○",
  in_progress: "◐",
  closed: "✓",
  cancelled: "✕",
  blocked: "●",
  deferred: "❄",
} as const;
const PRIORITY_COLORS = ["\x1b[31m", "\x1b[33m", "\x1b[35m", "\x1b[34m", "\x1b[90m"] as const;
const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";

export interface HumanOutputIssue extends Pick<Issue, "id" | "title" | "status" | "priority"> {
  display_id: string;
  updated_at?: string;
  parent_display_id?: string | null;
  sync_status?: Issue["sync_status"];
  is_blocked?: boolean;
}

export function toHumanOutputIssue(
  issue: Pick<Issue, "id" | "title" | "status" | "priority" | "updated_at" | "sync_status">,
  displayId: string,
  extras?: Partial<Omit<HumanOutputIssue, "id" | "title" | "status" | "priority" | "display_id">>
): HumanOutputIssue {
  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    display_id: displayId,
    updated_at: issue.updated_at,
    sync_status: issue.sync_status,
    ...extras,
  };
}

export interface BeadsRelationSectionOptions {
  indent?: string;
  showCount?: boolean;
  emptyLabel?: string;
}

/**
 * Format issue for human-readable output
 */
export function formatIssueHuman(issue: Issue, displayId?: string): string {
  const plainIssue = issueWithPlainDescription(issue);
  const mediaCount = listMediaItemsForIssue(plainIssue.local_id || plainIssue.id).length;
  const lines: string[] = [];
  lines.push(`${displayId || plainIssue.id}: ${plainIssue.title}`);
  lines.push(`  Status: ${plainIssue.status}`);
  lines.push(`  Priority: ${PRIORITY_LABELS[plainIssue.priority] || plainIssue.priority}`);
  if (plainIssue.issue_type) {
    lines.push(`  Type: ${plainIssue.issue_type}`);
  }
  if (plainIssue.assignee) {
    lines.push(`  Assignee: ${plainIssue.assignee}`);
  }
  if (mediaCount > 0) {
    lines.push(
      `  Media: ${mediaCount} ${mediaCount === 1 ? "item" : "items"} (use 'lb media' to retrieve them)`
    );
  }
  if (plainIssue.description) {
    lines.push(`  Description: ${plainIssue.description}`);
  }
  return lines.join("\n");
}

function beadsOutputUsesColor(): boolean {
  return Boolean(process.stdout.isTTY);
}

function beadsPriorityDot(priority: number): string {
  if (!beadsOutputUsesColor()) {
    return "●";
  }

  const color = PRIORITY_COLORS[priority] ?? PRIORITY_COLORS[2];
  return `${color}●${ANSI_RESET}`;
}

function beadsPriorityLabel(priority: number): string {
  const label = BEADS_PRIORITY_LABELS[priority] ?? "P2";
  if (!beadsOutputUsesColor()) {
    return label;
  }

  const color = PRIORITY_COLORS[priority] ?? PRIORITY_COLORS[2];
  return `${color}${label}${ANSI_RESET}`;
}

function beadsDim(text: string): string {
  if (!beadsOutputUsesColor()) {
    return text;
  }
  return `${ANSI_DIM}${text}${ANSI_RESET}`;
}

function beadsStatusSymbol(issue: HumanOutputIssue): string {
  if (issue.is_blocked) {
    return STATUS_SYMBOLS.blocked;
  }
  return STATUS_SYMBOLS[issue.status] || "?";
}

/**
 * Format issue for human-readable output
 */
export function formatIssuesListHuman(issues: HumanOutputIssue[]): string {
  if (issues.length === 0) {
    return "No issues found.";
  }

  const lines: string[] = [];
  const maxIdLen = Math.max(...issues.map((i) => i.display_id.length));

  for (const issue of issues) {
    const id = issue.display_id.padEnd(maxIdLen);
    const status = issue.status.padEnd(12);
    const priority = PRIORITY_LABELS[issue.priority]?.slice(0, 4).padEnd(4) || "    ";
    const title = issue.title;
    const parentInfo = issue.parent_display_id ? ` (↳ ${issue.parent_display_id})` : "";
    const syncingSuffix = issue.sync_status === "pending" ? " (syncing...)" : "";
    lines.push(`${id}  ${status}  ${priority}  ${title}${parentInfo}${syncingSuffix}`);
  }

  return lines.join("\n");
}

export function formatIssueLineBeads(issue: HumanOutputIssue, prefix: string = ""): string {
  const syncingSuffix = issue.sync_status === "pending" ? ` ${beadsDim("(syncing...)")}` : "";
  return `${prefix}${beadsStatusSymbol(issue)} ${issue.display_id} ${beadsPriorityDot(issue.priority)} ${beadsPriorityLabel(issue.priority)} ${issue.title}${syncingSuffix}`;
}

export function formatIssueSummaryBeads(issue: HumanOutputIssue, prefix: string = ""): string {
  return formatIssueLineBeads(issue, prefix);
}

export function formatIssueRelationSectionBeads(
  title: string,
  issues: HumanOutputIssue[],
  options?: BeadsRelationSectionOptions
): string {
  if (issues.length === 0) {
    return options?.emptyLabel ? `${title}: ${options.emptyLabel}` : "";
  }

  const indent = options?.indent || "";
  const showCount = options?.showCount ?? true;
  const heading = showCount ? `${title} (${issues.length}):` : `${title}:`;
  const lines = [`${indent}${heading}`];

  issues.forEach((issue, index) => {
    const connector = index === issues.length - 1 ? "└── " : "├── ";
    lines.push(formatIssueSummaryBeads(issue, `${indent}${connector}`));
  });

  return lines.join("\n");
}

export function formatIssueHumanBeads(
  issue: Issue,
  displayId?: string,
  options?: { isBlocked?: boolean }
): string {
  const plainIssue = issueWithPlainDescription(issue);
  const mediaCount = listMediaItemsForIssue(plainIssue.local_id || plainIssue.id).length;
  const summary = toHumanOutputIssue(plainIssue, displayId || plainIssue.id, {
    is_blocked: options?.isBlocked || false,
  });
  const lines: string[] = [formatIssueSummaryBeads(summary)];

  if (plainIssue.issue_type) {
    lines.push(`  Type: ${plainIssue.issue_type}`);
  }
  if (plainIssue.assignee) {
    lines.push(`  Assignee: ${plainIssue.assignee}`);
  }
  if (mediaCount > 0) {
    lines.push(
      `  Media: ${mediaCount} ${mediaCount === 1 ? "item" : "items"} (use 'lb media' to retrieve them)`
    );
  }
  if (plainIssue.description) {
    lines.push(`  Description: ${plainIssue.description}`);
  }

  return lines.join("\n");
}

function sortBeadsChildren(a: HumanOutputIssue, b: HumanOutputIssue): number {
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  return a.title.localeCompare(b.title);
}

function buildBeadsTreeLines(issues: HumanOutputIssue[]): string[] {
  const issueMap = new Map<string, HumanOutputIssue>();
  const childrenByParent = new Map<string, HumanOutputIssue[]>();
  const childIds = new Set<string>();

  for (const issue of issues) {
    issueMap.set(issue.display_id, issue);
  }

  for (const issue of issues) {
    const parentId = issue.parent_display_id;
    if (!parentId || !issueMap.has(parentId)) {
      continue;
    }
    childIds.add(issue.display_id);
    const children = childrenByParent.get(parentId) || [];
    children.push(issue);
    childrenByParent.set(parentId, children);
  }

  for (const children of childrenByParent.values()) {
    children.sort(sortBeadsChildren);
  }

  const lines: string[] = [];

  function visitDescendants(
    parent: HumanOutputIssue,
    ancestorPrefix: string,
    parentIsLast: boolean
  ): void {
    const children = childrenByParent.get(parent.display_id);
    if (!children || children.length === 0) {
      return;
    }

    const branchPrefix = `${ancestorPrefix}${parentIsLast ? "    " : "│   "}`;
    children.forEach((child, index) => {
      const isLast = index === children.length - 1;
      const connector = isLast ? "└── " : "├── ";
      lines.push(formatIssueLineBeads(child, `${branchPrefix}${connector}`));
      visitDescendants(child, branchPrefix, isLast);
    });
  }

  const topLevel = issues.filter((issue) => !childIds.has(issue.display_id));

  for (const issue of topLevel) {
    lines.push(formatIssueLineBeads(issue));
    visitDescendants(issue, "", true);
  }

  return lines;
}

function formatBeadsFooter(issues: HumanOutputIssue[], includeBlockedLegend: boolean): string {
  const counts: Partial<Record<Issue["status"], number>> = {};
  let blockedCount = 0;

  for (const issue of issues) {
    counts[issue.status] = (counts[issue.status] || 0) + 1;
    if (issue.is_blocked) {
      blockedCount += 1;
    }
  }

  const parts: string[] = [];
  if (counts.open) parts.push(`${counts.open} open`);
  if (counts.in_progress) parts.push(`${counts.in_progress} in progress`);
  if (includeBlockedLegend && blockedCount) parts.push(`${blockedCount} blocked`);
  if (counts.closed) parts.push(`${counts.closed} closed`);

  const summary = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${"─".repeat(80)}\nTotal: ${issues.length} issues${summary}\n\nStatus: ○ open  ◐ in_progress  ● blocked  ✓ closed  ❄ deferred`;
}

export function formatIssuesListHumanBeads(issues: HumanOutputIssue[]): string {
  if (issues.length === 0) {
    return "No issues found.";
  }

  return `${buildBeadsTreeLines(issues).join("\n")}\n\n${formatBeadsFooter(issues, true)}`;
}

export function formatReadyHuman(issues: HumanOutputIssue[]): string {
  if (issues.length === 0) {
    return "No ready issues.";
  }

  const lines: string[] = [];
  lines.push(
    `\n📋 Ready work (${issues.length} issue${issues.length === 1 ? "" : "s"} with no blockers):\n`
  );

  issues.forEach((issue, index) => {
    const parentInfo = issue.parent_display_id ? ` (↳ ${issue.parent_display_id})` : "";
    lines.push(
      `${index + 1}. [P${issue.priority}] ${issue.display_id}: ${issue.title}${parentInfo}`
    );
  });

  lines.push("");
  return lines.join("\n");
}

export function formatReadyHumanBeads(issues: HumanOutputIssue[]): string {
  if (issues.length === 0) {
    return "No ready issues.";
  }

  return `${buildBeadsTreeLines(issues).join("\n")}\n\n${formatBeadsFooter(issues, false)}`;
}

/**
 * Output result (JSON or human-readable)
 */
export function output(data: string): void {
  console.log(data);
}

/**
 * Output error
 */
export function outputError(message: string): void {
  console.error(message);
}
