/**
 * Output formatting utilities
 * Ensures bd-compatible JSON output
 */

import type { Issue, Dependency } from "../types.js";

/**
 * Format issues for JSON output (always returns array)
 */
export function formatIssuesJson(issues: Issue[]): string {
  return JSON.stringify(issues, null, 2);
}

/**
 * Format single issue for JSON output (returns array with one element)
 */
export function formatIssueJson(issue: Issue): string {
  return JSON.stringify([issue], null, 2);
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
  const formatted = {
    id: issue.id,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    // Only include issue_type if set
    ...(issue.issue_type ? { issue_type: issue.issue_type } : {}),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    // bd-style: only include assignee if non-null
    ...(issue.assignee ? { assignee: issue.assignee } : {}),
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

/**
 * Format issue for human-readable output
 */
export function formatIssueHuman(issue: Issue): string {
  const lines: string[] = [];
  lines.push(`${issue.id}: ${issue.title}`);
  lines.push(`  Status: ${issue.status}`);
  lines.push(`  Priority: ${PRIORITY_LABELS[issue.priority] || issue.priority}`);
  if (issue.issue_type) {
    lines.push(`  Type: ${issue.issue_type}`);
  }
  if (issue.assignee) {
    lines.push(`  Assignee: ${issue.assignee}`);
  }
  if (issue.description) {
    lines.push(`  Description: ${issue.description}`);
  }
  return lines.join("\n");
}

/**
 * Format issues list for human-readable output
 */
export function formatIssuesListHuman(issues: Issue[]): string {
  if (issues.length === 0) {
    return "No issues found.";
  }

  const lines: string[] = [];
  const maxIdLen = Math.max(...issues.map((i) => i.id.length));

  for (const issue of issues) {
    const id = issue.id.padEnd(maxIdLen);
    const status = issue.status.padEnd(11);
    const priority = PRIORITY_LABELS[issue.priority]?.slice(0, 4).padEnd(4) || "    ";
    const title = issue.title.slice(0, 60);
    lines.push(`${id}  ${status}  ${priority}  ${title}`);
  }

  return lines.join("\n");
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
