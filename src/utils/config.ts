/**
 * Configuration management for lb-cli
 * Loads from environment, JSONC config files, and CLI options
 *
 * Config sources (in priority order):
 * 1. CLI options (highest priority)
 * 2. Per-repo config (.lb/config.jsonc)
 * 3. Global config (~/.config/lb/config.jsonc)
 * 4. Environment variables
 * 5. Defaults (lowest priority)
 */

import type { HttpsLbCliDevConfigSchemaJson as ConfigTypes } from "../types/config.generated.js";
import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { parse as parseJsonc } from "jsonc-parser";

// Combined config type that includes both schema-defined options and legacy env var options
interface LoadedConfig extends ConfigTypes {
  api_key?: string;
  team_id?: string;
  team_key?: string;
}

let loadedConfig: LoadedConfig | null = null;

/**
 * Check if current directory is inside a git worktree
 * In worktrees, .git is a file pointing to the main repo's .git directory
 */
function isWorktree(dir: string = process.cwd()): boolean {
  const gitPath = join(dir, ".git");
  if (!existsSync(gitPath)) {
    return false;
  }

  try {
    const stats = statSync(gitPath);
    // If .git is a file, it's a worktree
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Get the main repository root when in a worktree
 * Uses git commands to find the actual repo root (not worktree path)
 */
function getMainRepoRoot(dir: string = process.cwd()): string | null {
  try {
    // Use git rev-parse --git-common-dir to get the main .git directory
    const { execSync } = require("child_process");
    const gitCommonDir = execSync("git rev-parse --git-common-dir", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    if (gitCommonDir) {
      // git-common-dir returns path to .git directory, parent is the repo root
      // Handle relative paths (git returns relative paths when in worktrees)
      if (gitCommonDir.startsWith("/")) {
        return dirname(gitCommonDir);
      } else {
        // Relative path - resolve from current directory
        return dirname(join(dir, gitCommonDir));
      }
    }
  } catch {
    // Not in a git repo or git not available
  }
  return null;
}

/**
 * Get global config path
 */
export function getGlobalConfigPath(): string {
  return join(homedir(), ".config", "lb", "config.jsonc");
}

/**
 * Get per-repo config path (from git root or cwd)
 */
export function getRepoConfigPath(): string {
  const gitRoot = findGitRootDir();
  const baseDir = gitRoot || process.cwd();
  return join(baseDir, ".lb", "config.jsonc");
}

/**
 * Get the best existing repo config path for writes.
 * Prefers existing .jsonc, falls back to existing .json, otherwise .jsonc.
 */
function getRepoConfigWritePath(): string {
  const jsoncPath = getRepoConfigPath();
  const jsonPath = jsoncPath.replace(/\.jsonc$/, ".json");

  if (existsSync(jsoncPath)) {
    return jsoncPath;
  }
  if (existsSync(jsonPath)) {
    return jsonPath;
  }
  return jsoncPath;
}

/**
 * Check whether repo config exists (.jsonc or .json).
 */
export function hasRepoConfig(): boolean {
  const jsoncPath = getRepoConfigPath();
  const jsonPath = jsoncPath.replace(/\.jsonc$/, ".json");
  return existsSync(jsoncPath) || existsSync(jsonPath);
}

/**
 * Parse a JSON or JSONC file, tolerating comments.
 */
function parseJsonLikeFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    const data = parseJsonc(content);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  } catch {
    // Ignore parse errors so callers can fall back to the next file
  }
  return null;
}

/**
 * Load a config layer by preferring .jsonc and falling back to .json.
 */
function loadConfigLayer(primaryPath: string): Record<string, unknown> | null {
  const candidates: string[] = [primaryPath];

  if (primaryPath.endsWith(".jsonc")) {
    candidates.push(primaryPath.replace(/\.jsonc$/, ".json"));
  } else if (primaryPath.endsWith(".json")) {
    candidates.unshift(primaryPath.replace(/\.json$/, ".jsonc"));
  }

  for (const candidate of candidates) {
    const parsed = parseJsonLikeFile(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

/**
 * Deep merge two objects (target <- source)
 * Source values override target values at all levels
 */
export function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key in source) {
    if (source[key] === undefined) continue;

    if (source[key] !== null && typeof source[key] === "object" && !Array.isArray(source[key])) {
      // Recursively merge nested objects
      result[key] = deepMerge(
        (result[key] as Record<string, unknown>) || {},
        source[key] as Record<string, unknown>
      ) as T[typeof key];
    } else {
      // Direct assignment for primitives and arrays
      result[key] = source[key] as T[typeof key];
    }
  }

  return result;
}

/**
 * Repo scoping mode type
 */
export type RepoScopeMode = "label" | "project" | "both";
export type RepoBindingVersion = 1 | 2;

const LEGACY_REPO_BINDING_VERSION: RepoBindingVersion = 1;
const PROJECT_DEFAULT_REPO_BINDING_VERSION: RepoBindingVersion = 2;

/**
 * Default config values
 */
export const DEFAULT_CONFIG: LoadedConfig = {
  use_issue_types: false,
  cache_ttl_seconds: 120,
  local_only: false,
  repo_binding_version: LEGACY_REPO_BINDING_VERSION,
  issue_backend: "linear",
  mail_backend: "local",
};

function parseRepoScope(value: unknown): RepoScopeMode | undefined {
  if (value === "label" || value === "project" || value === "both") {
    return value;
  }
  return undefined;
}

function parseRepoBindingVersion(value: unknown): RepoBindingVersion | undefined {
  if (value === 1 || value === 2) {
    return value;
  }
  return undefined;
}

function scopeFromBindingVersion(version: RepoBindingVersion): RepoScopeMode {
  if (version >= PROJECT_DEFAULT_REPO_BINDING_VERSION) {
    return "project";
  }
  return "label";
}

function resolveRepoScopeFromLayers(layers: Array<Record<string, unknown> | null>): RepoScopeMode {
  for (const layer of layers) {
    const scope = parseRepoScope(layer?.repo_scope);
    if (scope) {
      return scope;
    }
  }

  for (const layer of layers) {
    const version = parseRepoBindingVersion(layer?.repo_binding_version);
    if (version) {
      return scopeFromBindingVersion(version);
    }
  }

  return "label";
}

function resolveRepoBindingVersionFromLayers(
  layers: Array<Record<string, unknown> | null>
): RepoBindingVersion {
  for (const layer of layers) {
    const version = parseRepoBindingVersion(layer?.repo_binding_version);
    if (version) {
      return version;
    }
  }

  return LEGACY_REPO_BINDING_VERSION;
}

/**
 * Find git root directory
 * When in a worktree, returns the main repository root (not the worktree path)
 */
function findGitRootDir(): string | null {
  let dir = process.cwd();
  while (dir !== "/") {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      // Check if this is a worktree ( .git is a file, not directory)
      try {
        const stats = statSync(gitPath);
        if (stats.isFile()) {
          // This is a worktree - get the main repo root
          const mainRepo = getMainRepoRoot(dir);
          if (mainRepo) {
            return mainRepo;
          }
        }
      } catch {
        // Fall through to return dir
      }
      return dir;
    }
    dir = join(dir, "..");
  }
  return null;
}

/**
 * Get repo name from git remote or directory name (heuristic fallback)
 */
function getRepoNameFromHeuristic(): string {
  const gitRoot = findGitRootDir();
  if (gitRoot) {
    // Try to get from git remote
    try {
      const gitConfigPath = join(gitRoot, ".git", "config");
      if (existsSync(gitConfigPath)) {
        const content = readFileSync(gitConfigPath, "utf-8");
        const match = content.match(/url = .*[/:]([^/]+)\.git/);
        if (match) {
          return match[1];
        }
      }
    } catch {
      // Fall through to directory name
    }
    // Use directory name
    return gitRoot.split("/").pop() || "unknown";
  }
  return process.cwd().split("/").pop() || "unknown";
}

/**
 * Load config from various sources
 */
function loadConfig(): LoadedConfig {
  // Start with defaults
  let config: LoadedConfig = { ...DEFAULT_CONFIG };

  // 1. Load global config (~/.config/lb/config.jsonc)
  const globalConfigPath = getGlobalConfigPath();
  const globalConfig = loadConfigLayer(globalConfigPath);
  if (globalConfig) {
    config = deepMerge(config, globalConfig as Partial<LoadedConfig>);
  }

  // 2. Load per-repo config (.lb/config.jsonc) - overrides global
  const repoConfigPath = getRepoConfigPath();
  const repoConfig = loadConfigLayer(repoConfigPath);
  if (repoConfig) {
    config = deepMerge(config, repoConfig as Partial<LoadedConfig>);
  }

  const scopeLayers = [repoConfig, globalConfig];
  config.repo_binding_version = resolveRepoBindingVersionFromLayers(scopeLayers);
  config.repo_scope = resolveRepoScopeFromLayers(scopeLayers);

  // 3. Environment variables override everything except CLI
  if (process.env.LINEAR_API_KEY) {
    config.api_key = process.env.LINEAR_API_KEY;
  }
  if (process.env.LB_TEAM_ID) {
    config.team_id = process.env.LB_TEAM_ID;
  }
  if (process.env.LB_TEAM_KEY) {
    config.team_key = process.env.LB_TEAM_KEY;
  }
  if (process.env.LB_REPO_NAME) {
    config.repo_name = process.env.LB_REPO_NAME;
  }

  // 4. If repo_name not set in config, use heuristic (lowest priority)
  if (!config.repo_name) {
    config.repo_name = getRepoNameFromHeuristic();
  }

  return config;
}

// Load config on module init
loadedConfig = loadConfig();

/**
 * Get a config option
 */
export function getOption<K extends keyof LoadedConfig>(
  key: K,
  cliValue?: LoadedConfig[K]
): LoadedConfig[K] {
  return cliValue ?? (loadedConfig?.[key] as LoadedConfig[K]);
}

/**
 * Get full config
 */
export function getConfig(): LoadedConfig {
  return { ...loadedConfig };
}

/**
 * Reload config from disk/environment.
 */
export function reloadConfig(): void {
  loadedConfig = loadConfig();
}

/**
 * Get API key (required for most operations)
 */
export function getApiKey(): string {
  const key = getOption("api_key");
  if (!key) {
    throw new Error(
      "LINEAR_API_KEY environment variable is required. Set it via LINEAR_API_KEY env var."
    );
  }
  return key;
}

/**
 * Get team key - from config or environment
 */
export function getTeamKey(): string | undefined {
  return getOption("team_key");
}

/**
 * Get repo label name for scoping
 */
export function getRepoLabel(): string {
  const repoName = getOption("repo_name") || "unknown";
  return `repo:${repoName}`;
}

/**
 * Check if issue types are enabled
 */
export function useTypes(): boolean {
  return getOption("use_issue_types") === true;
}

/**
 * Get repo name (for use by LIN-458)
 */
export function getRepoName(): string | undefined {
  return getOption("repo_name");
}

/**
 * Check if running in local-only mode (no Linear sync)
 */
export function isLocalOnly(): boolean {
  return getOption("local_only") === true;
}

/**
 * Get repo scoping mode (label, project, or both)
 */
export function getRepoScope(): RepoScopeMode {
  return (getOption("repo_scope") as RepoScopeMode) || "label";
}

export function getRepoBindingVersion(): RepoBindingVersion {
  return parseRepoBindingVersion(getOption("repo_binding_version")) || LEGACY_REPO_BINDING_VERSION;
}

/**
 * Check if project scoping is enabled (project or both mode)
 */
export function useProjectScope(): boolean {
  const scope = getRepoScope();
  return scope === "project" || scope === "both";
}

/**
 * Check if label scoping is enabled (label or both mode)
 */
export function useLabelScope(): boolean {
  const scope = getRepoScope();
  return scope === "label" || scope === "both";
}

export function getIssueBackendKind(): "linear" | "local" {
  const value = getOption("issue_backend") as string | undefined;
  return value === "local" ? "local" : "linear";
}

export function getMailBackendKind(): "linear" | "local" {
  const value = getOption("mail_backend") as string | undefined;
  return value === "linear" ? "linear" : "local";
}

/**
 * Get database path
 */
export function getDbPath(): string {
  const gitRoot = findGitRootDir();
  const baseDir = gitRoot || process.cwd();
  return join(baseDir, ".lb", "cache.db");
}

/**
 * Update per-repo config values and persist them to disk.
 */
export function writeRepoConfig(updates: Partial<LoadedConfig>): string {
  const configPath = getRepoConfigWritePath();
  const existing = loadConfigLayer(configPath) as Partial<LoadedConfig> | null;
  const merged = deepMerge((existing || {}) as LoadedConfig, updates);

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`);
  reloadConfig();

  return configPath;
}
