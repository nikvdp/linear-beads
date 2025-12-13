/**
 * lb auth - Configure Linear API key globally
 */

import { Command } from "commander";
import { writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { dirname } from "path";
import { getGlobalConfigPath } from "../utils/config.js";
import { verifyConnection } from "../utils/linear.js";
import { output } from "../utils/output.js";

export const authCommand = new Command("auth")
  .description("Configure Linear API key globally")
  .option("--team <key>", "Also save team key to global config")
  .action(async (options) => {
    try {
      // Prompt for API key (masked)
      console.log("Enter your Linear API key (get one at https://linear.app/settings/api):");
      const apiKey = await promptPassword();

      if (!apiKey || apiKey.trim() === "") {
        console.error("Error: API key cannot be empty");
        process.exit(1);
      }

      // Set env var temporarily for verification
      process.env.LINEAR_API_KEY = apiKey;

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
      const configPath = getGlobalConfigPath();
      const configDir = dirname(configPath);

      // Create directory if needed
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }

      // Write config file
      writeFileSync(configPath, JSON.stringify(config, null, 2));

      // Set file permissions to 0600 (read/write for owner only)
      chmodSync(configPath, 0o600);

      // Show success
      output(`\nAuthenticated as: ${userInfo.userName}`);
      const teamsList = userInfo.teams.map(t => `${t.name} (${t.key})`).join(", ");
      output(`Teams: ${teamsList}`);
      output(`\nConfig saved to ${configPath}`);
      
      if (userInfo.teams.length === 1 && !options.team) {
        output(`Team auto-detected: ${userInfo.teams[0].key}`);
      } else if (userInfo.teams.length > 1 && !options.team) {
        output("\nNote: You have multiple teams. Use --team <key> to set a default, or it will be auto-detected per command.");
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
  // Use Bun.password if available, otherwise fallback
  if (typeof Bun !== "undefined" && "password" in Bun) {
    return await Bun.password("");
  }

  // Fallback for non-Bun environments
  const { createInterface } = await import("readline");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    // Disable echo
    if (process.stdin.isTTY) {
      (process.stdin as any).setRawMode(true);
    }

    let password = "";
    process.stdin.on("data", (char) => {
      const ch = char.toString("utf8");
      
      switch (ch) {
        case "\n":
        case "\r":
        case "\u0004": // Ctrl-D
          if (process.stdin.isTTY) {
            (process.stdin as any).setRawMode(false);
          }
          process.stdin.pause();
          console.log(""); // New line
          resolve(password);
          break;
        case "\u0003": // Ctrl-C
          process.exit(1);
          break;
        case "\u007f": // Backspace
        case "\b":
          if (password.length > 0) {
            password = password.slice(0, -1);
          }
          break;
        default:
          password += ch;
          break;
      }
    });
  });
}
