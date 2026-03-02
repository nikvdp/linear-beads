/**
 * lb dedupe - Find and consolidate duplicate issues
 */

import { Command } from "commander";
import type { Dependency } from "../types.js";
import {
  cacheDependency,
  deleteCachedIssue,
  getCachedIssues,
  getDependencies,
  getDisplayId,
  getInverseDependencies,
  queueOutboxItem,
  resolveIssueLocalId,
} from "../utils/database.js";
import { isLocalOnly } from "../utils/config.js";
import { buildTitleDuplicateClusters } from "../utils/duplicate-detection.js";
import { output, outputError } from "../utils/output.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";

type DedupeScope = "open" | "all";
type DedupeBy = "title";
type RelationType = "blocks" | "related";

interface RelationCreate {
  issueId: string;
  relatedIssueId: string;
  type: RelationType;
}

interface ParentUpdate {
  issueId: string;
  parentId: string | null;
}

interface ClusterPlan {
  title: string;
  canonicalId: string;
  duplicateIds: string[];
  dependenciesToAdd: Dependency[];
  relationCreates: RelationCreate[];
  parentUpdates: ParentUpdate[];
}

function dependencyKey(dep: Dependency): string {
  const left = resolveIssueLocalId(dep.issue_id);
  const right = resolveIssueLocalId(dep.depends_on_id);
  if (dep.type === "related") {
    const sorted = [left, right].sort();
    return `${dep.type}:${sorted[0]}:${sorted[1]}`;
  }
  return `${dep.type}:${left}:${right}`;
}

function relationKey(relation: RelationCreate): string {
  const left = resolveIssueLocalId(relation.issueId);
  const right = resolveIssueLocalId(relation.relatedIssueId);
  if (relation.type === "related") {
    const sorted = [left, right].sort();
    return `${relation.type}:${sorted[0]}:${sorted[1]}`;
  }
  return `${relation.type}:${left}:${right}`;
}

function parentUpdateKey(update: ParentUpdate): string {
  return `${resolveIssueLocalId(update.issueId)}:${update.parentId ? resolveIssueLocalId(update.parentId) : "null"}`;
}

function buildClusterPlan(canonicalId: string, duplicateIds: string[]): ClusterPlan {
  const duplicateSet = new Set(duplicateIds.map((id) => resolveIssueLocalId(id)));
  const canonicalLocal = resolveIssueLocalId(canonicalId);
  const allClusterIds = new Set([...duplicateSet, canonicalLocal]);

  const depsToAdd: Dependency[] = [];
  const depKeys = new Set<string>();
  const relationCreates: RelationCreate[] = [];
  const relationKeys = new Set<string>();
  const parentUpdates: ParentUpdate[] = [];
  const parentKeys = new Set<string>();

  const canonicalParent = getDependencies(canonicalLocal).find(
    (dep) => dep.type === "parent-child"
  );
  let canonicalParentId = canonicalParent?.depends_on_id || null;

  const addDependency = (dep: Dependency, relationType?: RelationType): void => {
    const normalized: Dependency = {
      ...dep,
      issue_id: resolveIssueLocalId(dep.issue_id),
      depends_on_id: resolveIssueLocalId(dep.depends_on_id),
    };
    if (normalized.issue_id === normalized.depends_on_id) {
      return;
    }

    const key = dependencyKey(normalized);
    if (depKeys.has(key)) {
      return;
    }
    depKeys.add(key);
    depsToAdd.push(normalized);

    if (relationType) {
      const relation: RelationCreate = {
        issueId: normalized.issue_id,
        relatedIssueId: normalized.depends_on_id,
        type: relationType,
      };
      const rKey = relationKey(relation);
      if (!relationKeys.has(rKey)) {
        relationKeys.add(rKey);
        relationCreates.push(relation);
      }
    }
  };

  const addParentUpdate = (issueId: string, parentId: string | null): void => {
    const update: ParentUpdate = {
      issueId: resolveIssueLocalId(issueId),
      parentId: parentId ? resolveIssueLocalId(parentId) : null,
    };
    if (update.issueId === update.parentId) {
      return;
    }
    const key = parentUpdateKey(update);
    if (parentKeys.has(key)) {
      return;
    }
    parentKeys.add(key);
    parentUpdates.push(update);
  };

  for (const duplicateId of duplicateSet) {
    const outgoing = getDependencies(duplicateId);
    const incoming = getInverseDependencies(duplicateId);

    const parentDep = outgoing.find((dep) => dep.type === "parent-child");
    if (parentDep) {
      const parentId = resolveIssueLocalId(parentDep.depends_on_id);
      if (!allClusterIds.has(parentId) && !canonicalParentId) {
        addDependency(
          {
            issue_id: canonicalLocal,
            depends_on_id: parentId,
            type: "parent-child",
            created_at: new Date().toISOString(),
            created_by: "local",
          },
          undefined
        );
        addParentUpdate(canonicalLocal, parentId);
        canonicalParentId = parentId;
      }
    }

    for (const dep of incoming) {
      if (dep.type !== "parent-child") {
        continue;
      }
      const childId = resolveIssueLocalId(dep.issue_id);
      if (allClusterIds.has(childId)) {
        continue;
      }
      addDependency(
        {
          issue_id: childId,
          depends_on_id: canonicalLocal,
          type: "parent-child",
          created_at: new Date().toISOString(),
          created_by: "local",
        },
        undefined
      );
      addParentUpdate(childId, canonicalLocal);
    }

    for (const dep of outgoing) {
      if (dep.type === "blocks") {
        const target = resolveIssueLocalId(dep.depends_on_id);
        if (allClusterIds.has(target)) {
          continue;
        }
        addDependency(
          {
            issue_id: canonicalLocal,
            depends_on_id: target,
            type: "blocks",
            created_at: new Date().toISOString(),
            created_by: "local",
          },
          "blocks"
        );
      }
      if (dep.type === "related") {
        const related = resolveIssueLocalId(dep.depends_on_id);
        if (allClusterIds.has(related)) {
          continue;
        }
        addDependency(
          {
            issue_id: canonicalLocal,
            depends_on_id: related,
            type: "related",
            created_at: new Date().toISOString(),
            created_by: "local",
          },
          "related"
        );
      }
    }

    for (const dep of incoming) {
      if (dep.type === "blocks") {
        const blocker = resolveIssueLocalId(dep.issue_id);
        if (allClusterIds.has(blocker)) {
          continue;
        }
        addDependency(
          {
            issue_id: blocker,
            depends_on_id: canonicalLocal,
            type: "blocks",
            created_at: new Date().toISOString(),
            created_by: "local",
          },
          "blocks"
        );
      }
      if (dep.type === "related") {
        const related = resolveIssueLocalId(dep.issue_id);
        if (allClusterIds.has(related)) {
          continue;
        }
        addDependency(
          {
            issue_id: canonicalLocal,
            depends_on_id: related,
            type: "related",
            created_at: new Date().toISOString(),
            created_by: "local",
          },
          "related"
        );
      }
    }
  }

  return {
    title: "",
    canonicalId: canonicalLocal,
    duplicateIds: [...duplicateSet],
    dependenciesToAdd: depsToAdd,
    relationCreates,
    parentUpdates,
  };
}

export const dedupeCommand = new Command("dedupe")
  .description("Detect and consolidate duplicate issues")
  .option("--by <mode>", "Duplicate grouping strategy (title)", "title")
  .option("--scope <scope>", "Scope to inspect (open|all)", "open")
  .option("--dry-run", "Preview duplicate consolidation (default)")
  .option("--execute", "Apply duplicate consolidation")
  .option("-j, --json", "Output as JSON")
  .action(async (options) => {
    try {
      const by = options.by as DedupeBy;
      const scope = options.scope as DedupeScope;
      const execute = Boolean(options.execute);
      const localOnly = isLocalOnly();

      if (by !== "title") {
        outputError(`Unsupported --by value '${options.by}'. Supported values: title`);
        process.exit(1);
      }
      if (scope !== "open" && scope !== "all") {
        outputError(`Unsupported --scope value '${options.scope}'. Supported values: open, all`);
        process.exit(1);
      }

      const candidateIssues = getCachedIssues().filter((issue) => {
        if (scope === "all") return true;
        return issue.status === "open" || issue.status === "in_progress";
      });
      const clusters = buildTitleDuplicateClusters(candidateIssues);

      const plans = clusters.map((cluster) => {
        const canonicalId = resolveIssueLocalId(cluster.canonical.id);
        const duplicateIds = cluster.duplicates.map((issue) => resolveIssueLocalId(issue.id));
        const plan = buildClusterPlan(canonicalId, duplicateIds);
        plan.title = cluster.canonical.title;
        return plan;
      });

      if (!execute) {
        const preview = {
          mode: "dry-run",
          by,
          scope,
          clusters: plans.map((plan) => ({
            title: plan.title,
            canonical: getDisplayId(plan.canonicalId),
            duplicates: plan.duplicateIds.map((id) => getDisplayId(id)),
            dependencies_to_add: plan.dependenciesToAdd.length,
            parent_updates: plan.parentUpdates.length,
            relations_to_create: plan.relationCreates.length,
            delete_count: plan.duplicateIds.length,
          })),
          totals: {
            clusters: plans.length,
            duplicate_issues: plans.reduce((sum, plan) => sum + plan.duplicateIds.length, 0),
            dependencies_to_add: plans.reduce(
              (sum, plan) => sum + plan.dependenciesToAdd.length,
              0
            ),
            parent_updates: plans.reduce((sum, plan) => sum + plan.parentUpdates.length, 0),
            relations_to_create: plans.reduce((sum, plan) => sum + plan.relationCreates.length, 0),
          },
        };

        if (options.json) {
          output(JSON.stringify(preview, null, 2));
        } else if (plans.length === 0) {
          output("No duplicate clusters found.");
        } else {
          output(`Found ${plans.length} duplicate cluster(s).`);
          for (const plan of preview.clusters) {
            output(
              `- ${plan.canonical} <= [${plan.duplicates.join(", ")}] | +deps:${plan.dependencies_to_add} +parent:${plan.parent_updates} +relations:${plan.relations_to_create}`
            );
          }
          output("Run with --execute to apply changes.");
        }
        return;
      }

      const queuedOperations = new Set<string>();
      let queuedCount = 0;
      let deletedCount = 0;

      for (const plan of plans) {
        for (const dep of plan.dependenciesToAdd) {
          cacheDependency(dep);
        }

        if (!localOnly) {
          for (const relation of plan.relationCreates) {
            const key = `create_relation:${relationKey(relation)}`;
            if (queuedOperations.has(key)) continue;
            queuedOperations.add(key);
            queueOutboxItem(
              "create_relation",
              {
                issueId: relation.issueId,
                relatedIssueId: relation.relatedIssueId,
                type: relation.type,
              },
              relation.issueId
            );
            queuedCount++;
          }

          for (const update of plan.parentUpdates) {
            const key = `update_parent:${parentUpdateKey(update)}`;
            if (queuedOperations.has(key)) continue;
            queuedOperations.add(key);
            queueOutboxItem(
              "update",
              {
                issueId: update.issueId,
                parentId: update.parentId,
              },
              update.issueId
            );
            queuedCount++;
          }
        }

        for (const duplicateId of plan.duplicateIds) {
          if (!localOnly) {
            const key = `delete:${resolveIssueLocalId(duplicateId)}`;
            if (!queuedOperations.has(key)) {
              queuedOperations.add(key);
              queueOutboxItem(
                "delete",
                {
                  issueId: duplicateId,
                },
                duplicateId
              );
              queuedCount++;
            }
          }
          deleteCachedIssue(duplicateId);
          deletedCount++;
        }
      }

      if (!localOnly && queuedCount > 0) {
        ensureOutboxProcessed();
      }

      const summary = {
        mode: "execute",
        by,
        scope,
        clusters: plans.length,
        duplicate_issues_deleted: deletedCount,
        dependencies_added: plans.reduce((sum, plan) => sum + plan.dependenciesToAdd.length, 0),
        parent_updates: plans.reduce((sum, plan) => sum + plan.parentUpdates.length, 0),
        relation_creates: plans.reduce((sum, plan) => sum + plan.relationCreates.length, 0),
        queued_operations: queuedCount,
      };

      if (options.json) {
        output(JSON.stringify(summary, null, 2));
      } else {
        output(
          `Applied dedupe across ${summary.clusters} cluster(s); deleted ${summary.duplicate_issues_deleted} duplicate issue(s).`
        );
      }
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
