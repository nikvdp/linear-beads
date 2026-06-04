/**
 * lb linear - Linear-specific recovery and maintenance commands
 */

import { Command } from "commander";
import {
  archiveIssue,
  closeIssue,
  fetchAllTeamIssuesForPrune,
  fetchIssue,
  getTeamId,
  getViewer,
} from "../utils/linear.js";
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
  getCommandRemoteSyncPause,
  recordRemoteSyncPause,
} from "../utils/remote-sync-state.js";

type PruneCandidate = Issue & {
  local_id?: string;
  linear_id: string;
  pre_archive_action?: "close";
};

type PruneSelectionOptions = {
  ageMs?: number;
  ageLabel?: string;
  nowMs?: number;
};

type TeamWideOwnershipScope = "viewer" | "all_users";

const LINEAR_IDENTIFIER_RE = /^([A-Z][A-Z0-9]{1,14})-\d+$/;

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

function parsePruneAge(value: unknown): { ageMs: number; ageLabel: string } | undefined {
  if (value === undefined) {
    return undefined;
  }

  const raw = String(value).trim().toLowerCase();
  const match = raw.match(
    /^(\d+)\s*(min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|mon|month|months)$/
  );
  if (!match) {
    throw new Error(`Invalid age '${value}'. Use a duration like 12h, 7d, 2w, or 1mo.`);
  }

  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid age '${value}'. Use a positive duration like 12h, 7d, 2w, or 1mo.`);
  }

  const unit = match[2];
  const unitMs =
    unit === "min" || unit === "mins" || unit === "minute" || unit === "minutes"
      ? 60 * 1000
      : unit === "h" || unit === "hr" || unit === "hrs" || unit === "hour" || unit === "hours"
        ? 60 * 60 * 1000
        : unit === "d" || unit === "day" || unit === "days"
          ? 24 * 60 * 60 * 1000
          : unit === "w" || unit === "wk" || unit === "wks" || unit === "week" || unit === "weeks"
            ? 7 * 24 * 60 * 60 * 1000
            : 30 * 24 * 60 * 60 * 1000;

  return {
    ageMs: amount * unitMs,
    ageLabel: raw,
  };
}

function comparePruneCandidates(a: PruneCandidate, b: PruneCandidate): number {
  const aClosedAt = a.closed_at || a.updated_at;
  const bClosedAt = b.closed_at || b.updated_at;
  return new Date(aClosedAt).getTime() - new Date(bClosedAt).getTime();
}

function isOldEnoughForPrune(issue: Issue, options: PruneSelectionOptions = {}): boolean {
  if (options.ageMs === undefined) {
    return true;
  }

  const referenceAt = issue.closed_at || issue.updated_at;
  const referenceMs = Date.parse(referenceAt);
  if (!Number.isFinite(referenceMs)) {
    return false;
  }

  const nowMs = options.nowMs ?? Date.now();
  return nowMs - referenceMs >= options.ageMs;
}

function toPruneCandidate(
  issue: Issue,
  options: PruneSelectionOptions = {},
  behavior: { allowActive?: boolean } = {}
): PruneCandidate | null {
  if (!issue.linear_id) {
    return null;
  }
  if ((issue.sync_status || "synced") !== "synced") {
    return null;
  }
  if (!isTerminalStatus(issue.status) && !behavior.allowActive) {
    return null;
  }
  if (issue.remote_archived_at) {
    return null;
  }
  if (!isOldEnoughForPrune(issue, options)) {
    return null;
  }

  return {
    ...issue,
    local_id: issue.local_id,
    linear_id: issue.linear_id,
    pre_archive_action: isTerminalStatus(issue.status) ? undefined : "close",
  };
}

function getAutomaticPruneCandidates(
  limit?: number,
  options: PruneSelectionOptions = {}
): PruneCandidate[] {
  const candidates = getCachedIssues()
    .map((issue) => toPruneCandidate(issue, options))
    .filter((issue): issue is PruneCandidate => issue !== null)
    .sort(comparePruneCandidates);

  return limit ? candidates.slice(0, limit) : candidates;
}

async function getTeamWidePruneCandidates(
  limit?: number,
  options: PruneSelectionOptions = {},
  ownershipScope: TeamWideOwnershipScope = "viewer"
): Promise<PruneCandidate[]> {
  const teamId = await getTeamId();
  let issues = await fetchAllTeamIssuesForPrune(teamId);

  if (ownershipScope === "viewer") {
    const viewer = await getViewer();
    const viewerEmail = viewer.email.toLowerCase();
    issues = issues.filter((issue) => issue.creator?.toLowerCase() === viewerEmail);
  }

  const candidates = issues
    .map((issue) => toPruneCandidate(issue, options))
    .filter((issue): issue is PruneCandidate => issue !== null)
    .sort(comparePruneCandidates);

  return limit ? candidates.slice(0, limit) : candidates;
}

async function resolveRequestedIssueForPrune(rawId: string): Promise<Issue> {
  const resolvedId = resolveIssueId(rawId);
  const cachedIssue = getCachedIssue(resolvedId);
  if (cachedIssue) {
    return cachedIssue;
  }

  const remoteIssue = await fetchIssue(resolvedId);
  if (!remoteIssue) {
    throw new Error(`Issue not found: ${rawId}`);
  }

  return getCachedIssue(remoteIssue.id) || remoteIssue;
}

async function getRequestedPruneCandidates(
  ids: string[],
  options: PruneSelectionOptions = {}
): Promise<PruneCandidate[]> {
  const candidates: PruneCandidate[] = [];
  const seenIssueIds = new Set<string>();

  for (const rawId of ids) {
    const issue = await resolveRequestedIssueForPrune(rawId);

    const candidate = toPruneCandidate(issue, options, { allowActive: true });
    if (!candidate) {
      if (issue.remote_archived_at) {
        throw new Error(`${getDisplayId(issue.id)} is already archived on Linear`);
      }
      if (!issue.linear_id || issue.sync_status !== "synced") {
        throw new Error(`${getDisplayId(issue.id)} is not synced to Linear yet`);
      }
      if (!isOldEnoughForPrune(issue, options)) {
        throw new Error(
          `${getDisplayId(issue.id)} is newer than --age ${options.ageLabel || "the requested threshold"}`
        );
      }
      throw new Error(`${getDisplayId(issue.id)} is not eligible for prune`);
    }

    if (seenIssueIds.has(candidate.id)) {
      continue;
    }
    seenIssueIds.add(candidate.id);
    candidates.push(candidate);
  }

  return candidates.sort(comparePruneCandidates);
}

function formatCandidateJson(candidate: PruneCandidate): Record<string, unknown> {
  return {
    id: getDisplayId(candidate.id),
    local_id: candidate.local_id || null,
    linear_id: candidate.linear_id,
    linear_identifier: candidate.linear_identifier || null,
    title: candidate.title,
    status: candidate.status,
    closed_at: candidate.closed_at || null,
    pre_archive_action: candidate.pre_archive_action || null,
  };
}

function inferTeamKeyFromCandidate(candidate: PruneCandidate): string | undefined {
  const identifiers = [candidate.linear_identifier, getDisplayId(candidate.id), candidate.id];

  for (const identifier of identifiers) {
    if (!identifier) {
      continue;
    }

    const match = identifier.match(LINEAR_IDENTIFIER_RE);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

async function getCloseTeamIdForCandidate(candidate: PruneCandidate): Promise<string> {
  return await getTeamId(inferTeamKeyFromCandidate(candidate));
}

function markArchivedCandidateLocally(candidate: PruneCandidate, archivedAt: string): void {
  const cached = getCachedIssue(candidate.id);
  if (!cached?.local_id) {
    return;
  }

  cacheIssue({
    ...cached,
    remote_archived_at: archivedAt,
  });
}

function getPruneScanScope(options: { mine?: boolean; all?: boolean }): {
  scanScope: "repo_cache" | "team";
  ownershipScope: TeamWideOwnershipScope | null;
} {
  return {
    scanScope: options.mine || options.all ? "team" : "repo_cache",
    ownershipScope: options.all ? "all_users" : options.mine ? "viewer" : null,
  };
}

function getNoCandidatesMessage(options: { mine?: boolean; all?: boolean }): string {
  if (!options.mine && !options.all) {
    return "No closed synced Linear issues are eligible for prune.";
  }

  if (options.all) {
    return "No closed synced Linear issues in the current Linear team are eligible for prune.";
  }

  return "No closed synced Linear issues created by you are eligible for prune.";
}

function getTeamScopeDescription(options: { mine?: boolean; all?: boolean }): string {
  if (!options.mine && !options.all) {
    return "";
  }

  if (options.all) {
    return " from the current Linear team created by any user";
  }

  return " from the current Linear team created by you";
}

export const linearCommand = new Command("linear")
  .description("Linear-specific maintenance commands")
  .addCommand(
    new Command("prune")
      .description("Archive closed or cancelled Linear issues while keeping local history")
      .argument("[ids...]", "Specific issue IDs to archive on Linear")
      .option("-l, --limit <count>", "Limit automatic prune candidates when no IDs are provided")
      .option("--age <duration>", "Only prune issues at least this old (for example: 7d, 2w, 1mo)")
      .option("--mine", "Scan the current Linear team for issues created by you")
      .option("--all", "Scan the current Linear team for issues created by any user")
      .option("--dry-run", "Force preview-only output without archiving anything")
      .option("-y, --yes", "Archive the selected issues instead of showing a preview")
      .option("-j, --json", "Output as JSON")
      .action(async (ids: string[], options) => {
        try {
          if (isLocalOnly()) {
            throw new Error("lb linear prune is unavailable in local-only mode");
          }

          const limit = parsePositiveLimit(options.limit);
          const ageFilter = parsePruneAge(options.age);
          if (ids.length > 0 && limit !== undefined) {
            throw new Error("--limit can only be used when no explicit issue IDs are provided");
          }
          if (options.mine && options.all) {
            throw new Error("--mine and --all cannot be used together");
          }
          if (ids.length > 0 && (options.mine || options.all)) {
            throw new Error(
              "--mine and --all can only be used when no explicit issue IDs are provided"
            );
          }
          if (options.yes && options.dryRun) {
            throw new Error("--yes and --dry-run cannot be used together");
          }

          const selectionOptions: PruneSelectionOptions = ageFilter || {};
          const ownershipScope: TeamWideOwnershipScope = options.all ? "all_users" : "viewer";

          const candidates =
            ids.length > 0
              ? await getRequestedPruneCandidates(ids, selectionOptions)
              : options.mine || options.all
                ? await getTeamWidePruneCandidates(limit, selectionOptions, ownershipScope)
                : getAutomaticPruneCandidates(limit, selectionOptions);

          const previewOnly = options.dryRun || !options.yes;
          const { scanScope, ownershipScope: outputOwnershipScope } = getPruneScanScope(options);

          if (candidates.length === 0) {
            if (options.json) {
              output(
                JSON.stringify(
                  {
                    preview: true,
                    scan_scope: scanScope,
                    ownership_scope: outputOwnershipScope,
                    dry_run: Boolean(options.dryRun),
                    age: ageFilter?.ageLabel || null,
                    candidates: [],
                    count: 0,
                  },
                  null,
                  2
                )
              );
            } else {
              output(getNoCandidatesMessage(options));
            }
            return;
          }

          if (previewOnly) {
            if (options.json) {
              output(
                JSON.stringify(
                  {
                    preview: true,
                    scan_scope: scanScope,
                    ownership_scope: outputOwnershipScope,
                    dry_run: Boolean(options.dryRun),
                    apply_required: true,
                    age: ageFilter?.ageLabel || null,
                    count: candidates.length,
                    candidates: candidates.map(formatCandidateJson),
                  },
                  null,
                  2
                )
              );
            } else {
              output(
                `${options.dryRun ? "Dry run:" : "Will archive"} ${candidates.length} closed Linear issue${
                  candidates.length === 1 ? "" : "s"
                }${getTeamScopeDescription(options)} and keep all local data${ageFilter ? ` (age >= ${ageFilter.ageLabel})` : ""}:`
              );
              for (const candidate of candidates) {
                const action = candidate.pre_archive_action
                  ? ` (will ${candidate.pre_archive_action} before archive)`
                  : "";
                output(
                  `- ${getDisplayId(candidate.id)} [${candidate.status}] ${candidate.title}${action}`
                );
              }
              output(
                options.dryRun
                  ? "Dry run only. Re-run with --yes to archive these issues on Linear."
                  : "Run with --yes to archive these issues on Linear."
              );
            }
            return;
          }

          const activePause = await getCommandRemoteSyncPause();
          if (activePause) {
            outputError(formatRemoteSyncPauseNotice(activePause));
            process.exit(1);
          }

          const archivedAt = new Date().toISOString();
          const archived: PruneCandidate[] = [];

          for (const candidate of candidates) {
            let archivedCandidate = candidate;
            if (candidate.pre_archive_action === "close") {
              const closedIssue = await closeIssue(
                candidate.linear_id,
                await getCloseTeamIdForCandidate(candidate),
                "Pruned by lb linear prune before archiving."
              );
              archivedCandidate = {
                ...candidate,
                ...closedIssue,
                local_id: candidate.local_id || closedIssue.local_id,
                linear_id: candidate.linear_id,
                linear_identifier: candidate.linear_identifier || closedIssue.linear_identifier,
                status: "closed",
                pre_archive_action: candidate.pre_archive_action,
              };
            }
            await archiveIssue(candidate.linear_id);
            markArchivedCandidateLocally(archivedCandidate, archivedAt);
            archived.push(archivedCandidate);
          }

          clearRemoteSyncPause();

          if (options.json) {
            output(
              JSON.stringify(
                {
                  preview: false,
                  scan_scope: scanScope,
                  ownership_scope: outputOwnershipScope,
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
