/**
 * Configuration management for lb-cli
 * Loads from environment, config file, and CLI options
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { Config } from "../types.js";

let loadedConfig: Config = {};

/**
 * Get global config path (~/.config/lb/config.json)
 */
export function getGlobalConfigPath(): string {
  return join(homedir(), ".config", "lb", "config.json");
}

/**
 * Find git root directory
 */
function findGitRoot(): string | null {
  let dir = process.cwd();
  while (dir !== "/") {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Get repo name from git remote or directory name
 */
function getRepoName(): string {
  const gitRoot = findGitRoot();
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
 * Priority: env vars > project config > global config
 */
function loadConfig(): Config {
  const config: Config = {};

  // 1. Load from global config first (~/.config/lb/config.json)
  const globalConfigPath = getGlobalConfigPath();
  if (existsSync(globalConfigPath)) {
    try {
      const content = readFileSync(globalConfigPath, "utf-8");
      Object.assign(config, JSON.parse(content));
    } catch {
      // Ignore errors in global config
    }
  }

  // 2. Try .lb.json in current dir or git root (overrides global)
  const gitRoot = findGitRoot();
  const configPaths = [".lb.json", ".lb/config.json"];
  if (gitRoot) {
    configPaths.push(join(gitRoot, ".lb.json"));
    configPaths.push(join(gitRoot, ".lb", "config.json"));
  }

  for (const path of configPaths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        Object.assign(config, JSON.parse(content));
        break;
      } catch {
        // Continue to next path
      }
    }
  }

  // 3. Environment variables override everything
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

  // 4. Default repo name from git
  if (!config.repo_name) {
    config.repo_name = getRepoName();
  }

  // 5. Default cache TTL
  if (!config.cache_ttl_seconds) {
    config.cache_ttl_seconds = 120; // 2 minutes
  }

  return config;
}

// Load on module init
loadedConfig = loadConfig();

/**
 * Get a config option
 */
export function getOption<K extends keyof Config>(key: K, cliValue?: Config[K]): Config[K] {
  return cliValue ?? loadedConfig[key];
}

/**
 * Get full config
 */
export function getConfig(): Config {
  return { ...loadedConfig };
}

/**
 * Get API key (required for most operations)
 */
export function getApiKey(): string {
  const key = getOption("api_key");
  if (!key) {
    throw new Error(
      "LINEAR_API_KEY is not set. Set it via environment variable or .lb.json config file."
    );
  }
  return key;
}

/**
 * Get team key - from config or directory name
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
  return getOption("use_types") === true;
}

/**
 * Get the label group name for types
 */
export function getTypeLabelGroup(): string {
  return getOption("type_label_group") || "Type";
}

/**
 * Get database path
 */
export function getDbPath(): string {
  const gitRoot = findGitRoot();
  const baseDir = gitRoot || process.cwd();
  return join(baseDir, ".lb", "cache.db");
}
