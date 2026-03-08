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
import { blockedCommand } from "./commands/blocked.js";
import { showCommand } from "./commands/show.js";
import { createCommand } from "./commands/create.js";
import { updateCommand } from "./commands/update.js";
import { closeCommand } from "./commands/close.js";
import { touchCommand } from "./commands/touch.js";
import { deleteCommand } from "./commands/delete.js";
import { depCommand } from "./commands/dep.js";
import { syncCommand } from "./commands/sync.js";
import { onboardCommand } from "./commands/onboard.js";
import { migrateCommand } from "./commands/migrate.js";
import { rebindCommand } from "./commands/rebind.js";
import { exportCommand } from "./commands/export.js";
import { selfUpdateCommand } from "./commands/self-update.js";
import { agentCommand } from "./commands/agent.js";
import { mailCommand } from "./commands/mail.js";
import { dedupeCommand } from "./commands/dedupe.js";
import { skillCommand } from "./commands/skill.js";
import { verifyConnection } from "./utils/issue-backend.js";
import { closeDatabase } from "./utils/database.js";
import { getRuntimeCliVersion } from "./utils/runtime-version.js";
import { exportToJsonl } from "./utils/jsonl.js";
import { processOutbox } from "./utils/background-sync-worker.js";
import { assertMinCliVersion, setRuntimeOverrides } from "./utils/config.js";

function currentCliVersion(): string {
  return getRuntimeCliVersion();
}

function shouldSkipMinCliGate(argv: string[]): boolean {
  if (
    argv.includes("--help") ||
    argv.includes("-h") ||
    argv.includes("--version") ||
    argv.includes("-V")
  ) {
    return true;
  }

  return argv.some((arg) => arg === "self-update");
}

function isValidTempNameMode(mode: string): mode is "label" | "project" | "both" {
  return mode === "label" || mode === "project" || mode === "both";
}

const cliVersion = currentCliVersion();
const program = new Command();

program
  .name("lb")
  .description("Linear-native beads-style issue tracker")
  .version(cliVersion)
  .option("--worker", "Internal: run background sync worker")
  .option("--export-worker", "Internal: run JSONL export worker")
  .option("--temp-name <name>", "Temporary scope name override for this command")
  .option("--temp-name-mode <mode>", "Temporary scope mode override: label, project, or both")
  .configureHelp({
    subcommandTerm: (cmd) => {
      const args = cmd.registeredArguments.map((a) =>
        a.required ? `<${a.name()}>` : `[${a.name()}]`
      );
      return args.length ? `${cmd.name()} ${args.join(" ")}` : cmd.name();
    },
  });

// Check for --worker flag before parsing commands
if (!shouldSkipMinCliGate(process.argv)) {
  try {
    assertMinCliVersion(cliVersion);
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (process.argv.includes("--worker")) {
  processOutbox()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
} else if (process.argv.includes("--export-worker")) {
  try {
    exportToJsonl();
    process.exit(0);
  } catch {
    process.exit(1);
  }
} else {
  // Add subcommands (grouped by purpose)
  // Setup
  program.addCommand(initCommand);
  program.addCommand(authCommand);
  program.addCommand(onboardCommand);

  // Issue operations
  program.addCommand(listCommand);
  program.addCommand(readyCommand);
  program.addCommand(blockedCommand);
  program.addCommand(showCommand);
  program.addCommand(createCommand);
  program.addCommand(updateCommand);
  program.addCommand(closeCommand);
  program.addCommand(touchCommand);
  program.addCommand(deleteCommand);
  program.addCommand(depCommand);

  // Sync & interop
  program.addCommand(syncCommand);
  program.addCommand(importCommand);
  program.addCommand(exportCommand);
  program.addCommand(selfUpdateCommand);
  program.addCommand(migrateCommand);
  program.addCommand(rebindCommand);
  program.addCommand(agentCommand);
  program.addCommand(mailCommand);
  program.addCommand(dedupeCommand);
  program.addCommand(skillCommand);

  program.hook("preAction", () => {
    const opts = program.opts<{ tempName?: string; tempNameMode?: string }>();
    const overrides: { repo_name?: string; repo_scope?: "label" | "project" | "both" } = {};

    if (opts.tempName) {
      overrides.repo_name = opts.tempName;
      // Ensure subprocesses (like detached sync workers) inherit CLI temp scope.
      process.env.LB_TEMP_NAME = opts.tempName;
    }

    if (opts.tempNameMode) {
      if (!isValidTempNameMode(opts.tempNameMode)) {
        throw new Error("--temp-name-mode must be one of: label, project, both");
      }
      overrides.repo_scope = opts.tempNameMode;
      // Ensure subprocesses (like detached sync workers) inherit CLI temp scope.
      process.env.LB_TEMP_NAME_MODE = opts.tempNameMode;
    }

    if (Object.keys(overrides).length > 0) {
      setRuntimeOverrides(overrides);
    }
  });

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
}
