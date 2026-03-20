/**
 * lb auth - Configure Linear API key globally
 */

import { Command } from "commander";
import { existsSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import {
  getGlobalConfigPath,
  getConfig,
  reloadConfig,
  writeGlobalConfig,
} from "../utils/config.js";
import { verifyConnection } from "../utils/issue-backend.js";
import { resetGraphQLClient } from "../utils/graphql.js";
import { output } from "../utils/output.js";

export const authCommand = new Command("auth")
  .description("Configure Linear API key globally")
  .option("--team <key>", "Also save team key to global config")
  .option("--show", "Show current config source and masked key")
  .option("--clear", "Remove global config")
  .action(async (options) => {
    // Handle --show
    if (options.show) {
      showConfig();
      return;
    }

    // Handle --clear
    if (options.clear) {
      clearConfig();
      return;
    }

    // Main auth flow
    try {
      // Prompt for API key (masked)
      process.stdout.write("Linear API key: ");
      const apiKey = await promptPassword();

      if (!apiKey || apiKey.trim() === "") {
        console.error("Error: API key cannot be empty");
        process.exit(1);
      }

      // Set env var temporarily for verification
      process.env.LINEAR_API_KEY = apiKey;
      reloadConfig();
      resetGraphQLClient();

      // Verify the key works
      console.log("\nVerifying API key...");
      let userInfo;
      try {
        userInfo = await verifyConnection();
      } catch (error) {
        console.error("Error: Invalid API key or network error");
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }

      // Build config object
      const config: Record<string, string> = {
        api_key: apiKey,
      };

      if (options.team) {
        config.team_key = options.team;
      }

      // Save to global config
      const configPath = writeGlobalConfig(config);
      resetGraphQLClient();

      // Show success
      output(`\nAuthenticated as: ${userInfo.userName}`);
      const teamsList = userInfo.teams.map((t) => `${t.name} (${t.key})`).join(", ");
      output(`Teams: ${teamsList}`);
      output(`\nConfig saved to ${configPath}`);

      if (userInfo.teams.length === 1 && !options.team) {
        output(`Team auto-detected: ${userInfo.teams[0].key}`);
      } else if (userInfo.teams.length > 1 && !options.team) {
        output(
          "\nNote: You have multiple teams. Use --team <key> to set a default, or it will be auto-detected per command."
        );
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * Prompt for password (masked input)
 */
async function promptPassword(): Promise<string> {
  // Simple approach: use stdin with raw mode
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Not a TTY, just read normally
      process.stdin.once("data", (data) => {
        resolve(data.toString().trim());
      });
      return;
    }

    // Disable echo
    (process.stdin as any).setRawMode(true);
    process.stdin.resume();

    let password = "";

    const onData = (char: Buffer) => {
      const str = char.toString("utf8");

      // Handle each character (paste support)
      for (const ch of str) {
        switch (ch) {
          case "\n":
          case "\r":
          case "\u0004": // Ctrl-D
            (process.stdin as any).setRawMode(false);
            process.stdin.removeListener("data", onData);
            process.stdin.pause();
            console.log(""); // New line
            resolve(password);
            return;
          case "\u0003": // Ctrl-C
            (process.stdin as any).setRawMode(false);
            process.exit(1);
            break;
          case "\u007f": // Backspace
          case "\b":
            if (password.length > 0) {
              password = password.slice(0, -1);
              // Visual feedback: move cursor back, print space, move back again
              process.stdout.write("\b \b");
            }
            break;
          default:
            password += ch;
            process.stdout.write("*"); // Show asterisks
            break;
        }
      }
    };

    process.stdin.on("data", onData);
  });
}

/**
 * Show current config source and masked key
 */
function showConfig(): void {
  const config = getConfig();
  const globalConfigPath = getGlobalConfigPath();

  // Determine source (check in priority order)
  let source = "not configured";
  let apiKey = config.api_key;

  if (process.env.LINEAR_API_KEY) {
    source = "environment variable (LINEAR_API_KEY)";
  } else {
    // Check for project config files
    const projectConfigs = [".lb/config.jsonc", ".lb/config.json"];

    // Also check git root
    const gitRoot = findGitRoot();
    if (gitRoot) {
      projectConfigs.push(join(gitRoot, ".lb", "config.jsonc"));
      projectConfigs.push(join(gitRoot, ".lb", "config.json"));
    }

    const hasProjectConfig = projectConfigs.some((p) => existsSync(p));

    if (hasProjectConfig) {
      source = "project config (.lb/config.jsonc)";
    } else {
      const globalCandidates = [globalConfigPath, globalConfigPath.replace(/\.jsonc$/, ".json")];
      const existingGlobalPath = globalCandidates.find((path) => existsSync(path));
      if (existingGlobalPath) {
        source = `global config (${existingGlobalPath})`;
      }
    }
  }

  output(`Config source: ${source}`);

  if (apiKey) {
    output(`API key: ${maskKey(apiKey)}`);
  } else {
    output("API key: (not configured)");
  }

  const teamKey = config.team_key;
  if (teamKey) {
    output(`Team key: ${teamKey}`);
  } else {
    output("Team key: (auto-detected)");
  }
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
 * Clear global config
 */
function clearConfig(): void {
  const globalConfigPath = getGlobalConfigPath();
  const candidates = [globalConfigPath, globalConfigPath.replace(/\.jsonc$/, ".json")].filter(
    (path, index, items) => items.indexOf(path) === index
  );
  const existing = candidates.filter((path) => existsSync(path));

  if (existing.length === 0) {
    output("No global config to clear");
    return;
  }

  for (const path of existing) {
    unlinkSync(path);
  }
  reloadConfig();
  resetGraphQLClient();
  output(`Global config removed: ${existing.join(", ")}`);
}

/**
 * Mask API key: show first 4 chars + *** + last 5 chars
 */
function maskKey(key: string): string {
  if (key.length < 10) {
    return "***";
  }
  return `${key.slice(0, 4)}***${key.slice(-5)}`;
}
