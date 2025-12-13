#!/usr/bin/env bun
/**
 * lb - Linear-native beads-style issue tracker CLI
 */

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { authCommand } from "./commands/auth.js";
import { importCommand } from "./commands/import.js";
import { listCommand } from "./commands/list.js";
import { readyCommand } from "./commands/ready.js";
import { showCommand } from "./commands/show.js";
import { createCommand } from "./commands/create.js";
import { updateCommand } from "./commands/update.js";
import { closeCommand } from "./commands/close.js";
import { syncCommand } from "./commands/sync.js";
import { onboardCommand } from "./commands/onboard.js";
import { verifyConnection } from "./utils/linear.js";
import { closeDatabase } from "./utils/database.js";

const program = new Command();

program
  .name("lb")
  .description("Linear-native beads-style issue tracker")
  .version("0.1.0");

// Add subcommands
program.addCommand(initCommand);
program.addCommand(authCommand);
program.addCommand(importCommand);
program.addCommand(listCommand);
program.addCommand(readyCommand);
program.addCommand(showCommand);
program.addCommand(createCommand);
program.addCommand(updateCommand);
program.addCommand(closeCommand);
program.addCommand(syncCommand);
program.addCommand(onboardCommand);

// Add whoami command for testing connection
program
  .command("whoami")
  .description("Verify Linear API connection")
  .option("-j, --json", "Output as JSON")
  .action(async (options) => {
    try {
      const info = await verifyConnection();
      if (options.json) {
        console.log(JSON.stringify(info, null, 2));
      } else {
        console.log(`Authenticated as: ${info.userName}`);
        console.log(`Teams: ${info.teams.map((t) => t.key).join(", ")}`);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Handle cleanup on exit
process.on("exit", () => {
  closeDatabase();
});

// Parse and run
program.parse();
