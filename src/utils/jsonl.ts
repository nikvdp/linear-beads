/**
 * JSONL export for git-friendly issue tracking
 * Exports issues to .lb/issues.jsonl (like beads)
 */

import { writeFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import { getDbPath } from "./config.js";
import { getCachedIssues, getDependencies } from "./database.js";

/**
 * Export all issues to .lb/issues.jsonl
 * Linear is source of truth, JSONL is read-only snapshot
 */
export function exportToJsonl(): void {
  try {
    const dbPath = getDbPath();
    const lbDir = dirname(dbPath);
    const jsonlPath = join(lbDir, "issues.jsonl");
    const tmpPath = `${jsonlPath}.tmp`;

    // Get all cached issues
    const issues = getCachedIssues();

    // Sort by ID for consistent ordering
    issues.sort((a, b) => a.id.localeCompare(b.id));

    // Build JSONL lines
    const lines: string[] = [];

    for (const issue of issues) {
      // Get dependencies for this issue
      const deps = getDependencies(issue.id);

      // Build issue object (same format as bd)
      const issueObj: Record<string, unknown> = {
        id: issue.id,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
      };

      // Optional fields
      if (issue.issue_type) {
        issueObj.issue_type = issue.issue_type;
      }
      if (issue.description) {
        issueObj.description = issue.description;
      }
      if (issue.closed_at) {
        issueObj.closed_at = issue.closed_at;
      }

      // Add dependencies array if any
      if (deps.length > 0) {
        issueObj.dependencies = deps;
      }

      // Write as compact JSON (one line)
      lines.push(JSON.stringify(issueObj));
    }

    // Atomic write: tmp file + rename
    writeFileSync(tmpPath, lines.join("\n") + "\n");
    renameSync(tmpPath, jsonlPath);
  } catch (error) {
    // Don't fail sync if export fails, just log
    console.error(
      "Warning: Failed to export JSONL:",
      error instanceof Error ? error.message : error
    );
  }
}
