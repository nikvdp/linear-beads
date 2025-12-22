/**
 * Core types for lb-cli
 * Designed to match bd (beads) JSON output as closely as possible
 */

// Issue status - matches bd semantics, maps to Linear workflow states
export type IssueStatus = "open" | "in_progress" | "closed";

// Issue type - matches bd
export type IssueType = "bug" | "feature" | "task" | "epic" | "chore";

// Priority - matches bd (0-4, 0 is highest)
export type Priority = 0 | 1 | 2 | 3 | 4;

// Dependency types - matches bd
export type DependencyType = "blocks" | "related" | "parent-child" | "discovered-from";

/**
 * Dependency edge - matches bd JSON shape exactly
 */
export interface Dependency {
  issue_id: string;
  depends_on_id: string;
  type: DependencyType;
  created_at: string;
  created_by: string;
}

/**
 * Issue - matches bd JSON shape
 * Used for list/show/ready output
 */
export interface Issue {
  id: string;
  title: string;
  description?: string;
  status: IssueStatus;
  priority: Priority;
  issue_type?: IssueType; // Optional - only set when use_types is enabled
  created_at: string;
  updated_at: string;
  closed_at?: string;
  // Assignee email (omit if unassigned for bd-style terse output)
  assignee?: string;
  // Optional fields for list output
  dependency_count?: number;
  dependent_count?: number;
  // Optional fields for ready output
  dependencies?: Dependency[];
}

/**
 * Linear-specific types for internal use
 */
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  canceledAt?: string | null;
  state: {
    id: string;
    name: string;
    type: string;
  };
  labels: {
    nodes: Array<{
      id: string;
      name: string;
    }>;
  };
  assignee?: {
    id: string;
    email: string;
    name: string;
  } | null;
  parent?: {
    id: string;
    identifier: string;
  } | null;
  children?: {
    nodes: Array<{
      id: string;
      identifier: string;
    }>;
  };
  relations?: {
    nodes: Array<{
      id: string;
      type: string;
      relatedIssue: {
        id: string;
        identifier: string;
      };
    }>;
  };
  inverseRelations?: {
    nodes: Array<{
      id: string;
      type: string;
      issue: {
        id: string;
        identifier: string;
      };
    }>;
  };
}

/**
 * Outbox item for queued mutations
 */
export interface OutboxItem {
  id: number;
  operation: "create" | "update" | "close" | "delete" | "create_relation" | "delete_relation";
  payload: Record<string, unknown>;
  created_at: string;
  retry_count: number;
  last_error?: string;
}

/**
 * Config for lb-cli
 */
export interface Config {
  api_key?: string;
  team_id?: string;
  team_key?: string;
  repo_name?: string;
  cache_ttl_seconds?: number;
  // Issue type labeling (off by default)
  use_issue_types?: boolean;
}

/**
 * Map bd status to Linear workflow state type
 */
export function statusToLinearState(status: IssueStatus): string {
  switch (status) {
    case "open":
      return "unstarted";
    case "in_progress":
      return "started";
    case "closed":
      return "completed";
  }
}

/**
 * Map Linear workflow state type to bd status
 */
export function linearStateToStatus(stateType: string): IssueStatus {
  switch (stateType) {
    case "started":
      return "in_progress";
    case "completed":
    case "canceled":
      return "closed";
    default:
      return "open";
  }
}

/**
 * Valid issue types
 */
export const VALID_ISSUE_TYPES: IssueType[] = ["bug", "feature", "task", "epic", "chore"];

/**
 * Extract issue type from labels (looks for label matching type name in a group)
 * Returns undefined if no type label found
 */
export function labelToIssueType(labels: string[]): IssueType | undefined {
  for (const label of labels) {
    // Check for exact match with type names (e.g., "Bug", "Feature")
    const normalized = label.toLowerCase();
    if (VALID_ISSUE_TYPES.includes(normalized as IssueType)) {
      return normalized as IssueType;
    }
    // Also check old format for backwards compatibility
    if (label.startsWith("type:")) {
      const type = label.slice(5).toLowerCase() as IssueType;
      if (VALID_ISSUE_TYPES.includes(type)) {
        return type;
      }
    }
  }
  return undefined;
}

/**
 * Map Linear priority to bd priority
 * Linear: 0=none, 1=urgent, 2=high, 3=medium, 4=low
 * bd: 0=critical, 1=high, 2=medium, 3=low, 4=backlog
 */
export function linearToPriority(linearPriority: number): Priority {
  if (linearPriority === 0) return 4;
  return (linearPriority - 1) as Priority;
}

/**
 * Map bd priority (0=critical) to Linear priority (1=urgent, 0=none)
 * bd: 0=critical, 1=high, 2=medium, 3=low, 4=backlog
 * Linear: 0=none, 1=urgent, 2=high, 3=medium, 4=low
 */
export function priorityToLinear(bdPriority: Priority): number {
  // bd 0 (critical) -> Linear 1 (urgent)
  // bd 1 (high) -> Linear 2 (high)
  // bd 2 (medium) -> Linear 3 (medium)
  // bd 3 (low) -> Linear 4 (low)
  // bd 4 (backlog) -> Linear 0 (none/backlog)
  if (bdPriority === 4) return 0;
  return bdPriority + 1;
}



/**
 * Priority name to number mapping
 * Accepts: urgent/critical (0), high (1), medium/med (2), low (3), backlog/none (4)
 */
const PRIORITY_NAMES: Record<string, Priority> = {
  urgent: 0,
  critical: 0,
  crit: 0,
  high: 1,
  medium: 2,
  med: 2,
  low: 3,
  backlog: 4,
  none: 4,
};

/**
 * Parse priority from string (number or name)
 * Returns { priority, error } - check error first
 */
export function parsePriority(value: string): { priority?: Priority; error?: string } {
  // Try numeric first
  const num = parseInt(value);
  if (!isNaN(num)) {
    if (num >= 0 && num <= 4) {
      return { priority: num as Priority };
    }
    return {
      error: `Invalid priority '${value}'. Must be 0-4 or: urgent, high, medium, low, backlog`,
    };
  }

  // Try name
  const name = value.toLowerCase();
  if (name in PRIORITY_NAMES) {
    return { priority: PRIORITY_NAMES[name] };
  }

  return {
    error: `Invalid priority '${value}'. Must be 0-4 or: urgent, high, medium, low, backlog`,
  };
}
