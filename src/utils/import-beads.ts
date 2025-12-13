/**
 * Import utilities for migrating from beads to lb
 */

import { readFileSync, existsSync } from "fs";
import type { IssueType, Priority, IssueStatus } from "../types.js";

/**
 * Beads issue structure (from .beads/issues.jsonl)
 */
export interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  status: IssueStatus;
  priority: Priority;
  issue_type: IssueType;
  created_at: string;
  updated_at?: string;
  closed_at?: string;
  dependencies?: BeadsDependency[];
  parent?: string;
}

/**
 * Beads dependency structure
 */
export interface BeadsDependency {
  type: string; // "blocks", "blocked-by", "discovered-from", "related"
  issue_id: string;
}

/**
 * Import options
 */
export interface ImportOptions {
  includeClosed?: boolean;
  since?: Date;
  source?: string;
}

/**
 * Parse beads JSONL file
 */
export function parseBeadsJsonl(path: string): BeadsIssue[] {
  if (!existsSync(path)) {
    throw new Error(`Beads file not found: ${path}`);
  }

  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n").filter(line => line.trim());
  const issues: BeadsIssue[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const issue = JSON.parse(lines[i]) as BeadsIssue;
      
      // Validate required fields
      if (!issue.id || !issue.title) {
        console.warn(`Line ${i + 1}: Missing required fields (id, title)`);
        continue;
      }

      issues.push(issue);
    } catch (error) {
      console.warn(`Line ${i + 1}: Failed to parse JSON:`, error instanceof Error ? error.message : error);
    }
  }

  return issues;
}

/**
 * Build dependency graph from issues
 * Returns map of issue ID -> list of dependency IDs
 */
export function buildDependencyGraph(issues: BeadsIssue[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();

  for (const issue of issues) {
    const deps: string[] = [];

    // Add parent as dependency
    if (issue.parent) {
      deps.push(issue.parent);
    }

    // Add explicit dependencies
    if (issue.dependencies) {
      for (const dep of issue.dependencies) {
        if (dep.type === "blocks" || dep.type === "blocked-by") {
          deps.push(dep.issue_id);
        }
      }
    }

    if (deps.length > 0) {
      graph.set(issue.id, deps);
    }
  }

  return graph;
}

/**
 * Filter issues based on options
 */
export function filterIssues(issues: BeadsIssue[], options: ImportOptions): BeadsIssue[] {
  let filtered = issues;

  // Filter by status (skip closed unless --include-closed)
  if (!options.includeClosed) {
    filtered = filtered.filter(issue => issue.status !== "closed");
  }

  // Filter by date (--since)
  if (options.since) {
    filtered = filtered.filter(issue => {
      const createdAt = new Date(issue.created_at);
      return createdAt >= options.since!;
    });
  }

  return filtered;
}

/**
 * Check for duplicate issues in Linear
 * Returns map of beads ID -> Linear ID for duplicates
 */
export async function checkDuplicates(
  issues: BeadsIssue[],
  teamId: string
): Promise<Map<string, string>> {
  const { getGraphQLClient } = await import("./graphql.js");
  const client = getGraphQLClient();
  const duplicates = new Map<string, string>();

  for (const issue of issues) {
    // Search Linear for issues with matching title
    const query = `
      query SearchIssues($teamId: String!, $title: String!) {
        issues(filter: {
          team: { id: { eq: $teamId } }
          title: { containsIgnoreCase: $title }
        }) {
          nodes {
            id
            title
          }
        }
      }
    `;

    try {
      const result = await client.request<{
        issues: { nodes: Array<{ id: string; title: string }> };
      }>(query, { teamId, title: issue.title });

      // Check for exact match (case-insensitive)
      const exactMatch = result.issues.nodes.find(
        (linear) => linear.title.toLowerCase() === issue.title.toLowerCase()
      );

      if (exactMatch) {
        duplicates.set(issue.id, exactMatch.id);
      }
    } catch (error) {
      console.warn(`Failed to check duplicates for ${issue.id}:`, error);
    }
  }

  return duplicates;
}

/**
 * Create imported issues in Linear with comment
 * Returns map of beads ID -> Linear ID
 */
export async function createImportedIssues(
  issues: BeadsIssue[],
  teamId: string
): Promise<Map<string, string>> {
  const { createIssue, addComment } = await import("./linear.js");
  const mapping = new Map<string, string>();

  for (const issue of issues) {
    try {
      // Create issue in Linear
      const created = await createIssue({
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        issueType: issue.issue_type,
        teamId,
      });

      // Add comment with beads ID reference
      await addComment(created.id, `Imported from beads issue: ${issue.id}`);

      // Store mapping
      mapping.set(issue.id, created.id);

      console.log(`✓ ${issue.id} → ${created.id}: "${issue.title}"`);
    } catch (error) {
      console.error(`✗ Failed to import ${issue.id}:`, error instanceof Error ? error.message : error);
    }
  }

  return mapping;
}
