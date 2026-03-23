/**
 * lb linear - Linear-specific recovery and maintenance commands
 */

import { Command } from "commander";
import { archiveIssue } from "../utils/linear.js";
import {
  cacheIssue,
  getCachedIssue,
  getCachedIssues,
  getDisplayId,
  resolveIssueId,
} from "../utils/database.js";
import { output, outputError } from "../utils/output.js";
import { isLocalOnly } from "../utils/config.js";
import { isTerminalStatus, type Issue } from "../types.js";
import {
  clearRemoteSyncPause,
  formatRemoteSyncPauseNotice,
  recordRemoteSyncPause,
} from "../utils/remote-sync-state.js";

type PruneCandidate = Issue & {
  local_id: string;
  linear_id: string;
};

function parsePositiveLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid limit '${value}'. Must be a positive integer.`);
  }

  return parsed;
}

function comparePruneCandidates(a: PruneCandidate, b: PruneCandidate): number {
  const aClosedAt = a.closed_at || a.updated_at;
  const bClosedAt = b.closed_at || b.updated_at;
  return new Date(aClosedAt).getTime() - new Date(bClosedAt).getTime();
}

function toPruneCandidate(issue: Issue): PruneCandidate | null {
  if (!issue.local_id || !issue.linear_id) {
    return null;
  }
  if (issue.sync_status !== "synced") {
    return null;
  }
  if (!isTerminalStatus(issue.status)) {
    return null;
  }
  if (issue.remote_archived_at) {
    return null;
  }

  return {
    ...issue,
    local_id: issue.local_id,
    linear_id: issue.linear_id,
  };
}

function getAutomaticPruneCandidates(limit?: number): PruneCandidate[] {
  const candidates = getCachedIssues()
    .map(toPruneCandidate)
    .filter((issue): issue is PruneCandidate => issue !== null)
    .sort(comparePruneCandidates);

  return limit ? candidates.slice(0, limit) : candidates;
}

function getRequestedPruneCandidates(ids: string[]): PruneCandidate[] {
  const candidates: PruneCandidate[] = [];
  const seenLocalIds = new Set<string>();

  for (const rawId of ids) {
    const resolvedId = resolveIssueId(rawId);
    const issue = getCachedIssue(resolvedId);
    if (!issue) {
      throw new Error(`Issue not found: ${rawId}`);
    }

    const candidate = toPruneCandidate(issue);
    if (!candidate) {
      if (issue.remote_archived_at) {
        throw new Error(`${getDisplayId(issue.id)} is already archived on Linear`);
      }
      if (!issue.linear_id || issue.sync_status !== "synced") {
        throw new Error(`${getDisplayId(issue.id)} is not synced to Linear yet`);
      }
      throw new Error(
        `${getDisplayId(issue.id)} is not closed or cancelled, so it is not eligible for prune`
      );
    }

    if (seenLocalIds.has(candidate.local_id)) {
      continue;
    }
    seenLocalIds.add(candidate.local_id);
    candidates.push(candidate);
  }

  return candidates.sort(comparePruneCandidates);
}

function formatCandidateJson(candidate: PruneCandidate): Record<string, unknown> {
  return {
    id: getDisplayId(candidate.id),
    local_id: candidate.local_id,
    linear_id: candidate.linear_id,
    linear_identifier: candidate.linear_identifier || null,
    title: candidate.title,
    status: candidate.status,
    closed_at: candidate.closed_at || null,
  };
}

export const linearCommand = new Command("linear")
  .description("Linear-specific maintenance commands")
  .addCommand(
    new Command("prune")
      .description("Archive closed or cancelled Linear issues while keeping local history")
      .argument("[ids...]", "Specific issue IDs to archive on Linear")
      .option("-l, --limit <count>", "Limit automatic prune candidates when no IDs are provided")
      .option("-y, --yes", "Archive the selected issues instead of showing a preview")
      .option("-j, --json", "Output as JSON")
      .action(async (ids: string[], options) => {
        try {
          if (isLocalOnly()) {
            throw new Error("lb linear prune is unavailable in local-only mode");
          }

          const limit = parsePositiveLimit(options.limit);
          if (ids.length > 0 && limit !== undefined) {
            throw new Error("--limit can only be used when no explicit issue IDs are provided");
          }

          const candidates =
            ids.length > 0 ? getRequestedPruneCandidates(ids) : getAutomaticPruneCandidates(limit);

          if (candidates.length === 0) {
            if (options.json) {
              output(JSON.stringify({ preview: true, candidates: [], count: 0 }, null, 2));
            } else {
              output("No closed synced Linear issues are eligible for prune.");
            }
            return;
          }

          if (!options.yes) {
            if (options.json) {
              output(
                JSON.stringify(
                  {
                    preview: true,
                    apply_required: true,
                    count: candidates.length,
                    candidates: candidates.map(formatCandidateJson),
                  },
                  null,
                  2
                )
              );
            } else {
              output(
                `Will archive ${candidates.length} closed Linear issue${
                  candidates.length === 1 ? "" : "s"
                } and keep all local data:`
              );
              for (const candidate of candidates) {
                output(
                  `- ${getDisplayId(candidate.id)} [${candidate.status}] ${candidate.title}`
                );
              }
              output("Run with --yes to archive these issues on Linear.");
            }
            return;
          }

          const archivedAt = new Date().toISOString();
          const archived: PruneCandidate[] = [];

          for (const candidate of candidates) {
            await archiveIssue(candidate.linear_id);
            cacheIssue({
              ...candidate,
              remote_archived_at: archivedAt,
            });
            archived.push(candidate);
          }

          clearRemoteSyncPause();

          if (options.json) {
            output(
              JSON.stringify(
                {
                  preview: false,
                  archived: archived.map(formatCandidateJson),
                  count: archived.length,
                  cleared_remote_pause: true,
                },
                null,
                2
              )
            );
          } else {
            output(
              `Archived ${archived.length} Linear issue${archived.length === 1 ? "" : "s"} and kept the local cache intact.`
            );
            output("Stored remote sync pause state was cleared. Run `lb sync` to retry.");
          }
        } catch (error) {
          const pause = recordRemoteSyncPause(error);
          if (pause) {
            outputError(formatRemoteSyncPauseNotice(pause));
          } else {
            outputError(error instanceof Error ? error.message : String(error));
          }
          process.exit(1);
        }
      })
  );
