/**
 * lb show - Show issue details
 */

import { Command } from "commander";
import { ensureFresh } from "../utils/sync.js";
import { getCachedIssue, getDependencies, getInverseDependencies } from "../utils/database.js";
import { fetchIssue } from "../utils/linear.js";
import { formatShowJson, formatIssueHuman, output, outputError } from "../utils/output.js";

export const showCommand = new Command("show")
  .description("Show issue details")
  .argument("<id>", "Issue ID (e.g., TEAM-123 or 123)")
  .option("-j, --json", "Output as JSON")
  .option("--sync", "Force sync before showing")
  .option("--team <team>", "Team key (overrides config)")
  .action(async (id: string, options) => {
    try {
      // Ensure cache is fresh
      await ensureFresh(options.team, options.sync);

      let issue;

      // With --sync, always fetch fresh from Linear to get relations
      if (options.sync) {
        issue = await fetchIssue(id);
      }

      // Try cache if not synced or fetch failed
      if (!issue) {
        issue = getCachedIssue(id);
      }

      // If still not found, try fetching directly
      if (!issue) {
        issue = await fetchIssue(id);
      }

      if (!issue) {
        outputError(`Issue not found: ${id}`);
        process.exit(1);
      }

      // Get dependencies (both directions)
      const outgoing = getDependencies(issue.id);
      const incoming = getInverseDependencies(issue.id);

      // Organize by relationship type
      const parent = outgoing.find(d => d.type === "parent-child")?.depends_on_id;
      const children = incoming.filter(d => d.type === "parent-child").map(d => d.issue_id);
      const blocks = outgoing.filter(d => d.type === "blocks").map(d => d.depends_on_id);
      const blockedBy = incoming.filter(d => d.type === "blocks").map(d => d.issue_id);
      const relatedOut = outgoing.filter(d => d.type === "related" || d.type === "discovered-from").map(d => d.depends_on_id);
      const relatedIn = incoming.filter(d => d.type === "related" || d.type === "discovered-from").map(d => d.issue_id);
      const related = [...new Set([...relatedOut, ...relatedIn])];

      // Output
      if (options.json) {
        const jsonOutput = {
          ...issue,
          parent: parent || null,
          children: children.length > 0 ? children : undefined,
          blocks: blocks.length > 0 ? blocks : undefined,
          blocked_by: blockedBy.length > 0 ? blockedBy : undefined,
          related: related.length > 0 ? related : undefined,
        };
        output(JSON.stringify([jsonOutput], null, 2));
      } else {
        output(formatIssueHuman(issue));
        
        // Show relationships
        let hasRelations = false;
        
        if (parent) {
          if (!hasRelations) { output(""); hasRelations = true; }
          const parentIssue = getCachedIssue(parent);
          output(`Parent: ${parent}${parentIssue ? `: ${parentIssue.title}` : ""}`);
        }
        
        if (children.length > 0) {
          if (!hasRelations) { output(""); hasRelations = true; }
          output(`Children (${children.length}):`);
          for (const childId of children) {
            const child = getCachedIssue(childId);
            output(`  ↳ ${childId}${child ? `: ${child.title} [P${child.priority}]` : ""}`);
          }
        }
        
        if (blocks.length > 0) {
          if (!hasRelations) { output(""); hasRelations = true; }
          output(`Blocks (${blocks.length}):`);
          for (const blockedId of blocks) {
            const blocked = getCachedIssue(blockedId);
            output(`  ← ${blockedId}${blocked ? `: ${blocked.title} [P${blocked.priority}]` : ""}`);
          }
        }
        
        if (blockedBy.length > 0) {
          if (!hasRelations) { output(""); hasRelations = true; }
          output(`Blocked by (${blockedBy.length}):`);
          for (const blockerId of blockedBy) {
            const blocker = getCachedIssue(blockerId);
            output(`  → ${blockerId}${blocker ? `: ${blocker.title} [P${blocker.priority}]` : ""}`);
          }
        }
        
        if (related.length > 0) {
          if (!hasRelations) { output(""); hasRelations = true; }
          output(`Related (${related.length}):`);
          for (const relId of related) {
            const rel = getCachedIssue(relId);
            output(`  ↔ ${relId}${rel ? `: ${rel.title} [P${rel.priority}]` : ""}`);
          }
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
