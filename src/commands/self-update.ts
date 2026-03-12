/**
 * lb self-update - Update lb from GitHub releases.
 */

import { Command } from "commander";
import { runSelfUpdate, type SelfUpdateResult } from "../utils/self-update.js";
import { output, outputError } from "../utils/output.js";

function formatResult(result: SelfUpdateResult): string {
  if (result.alreadyUpdated) {
    return `Already up to date: ${result.localVersion}`;
  }

  const target = result.updatedPath || result.binaryPath;
  return `Updated lb to ${result.remoteVersion}\nReplaced: ${target}`;
}

export const selfUpdateCommand = new Command("self-update")
  .description("Update lb from the latest GitHub release")
  .option("--check", "Only check for updates")
  .option("--force", "Force reinstall even if already at latest")
  .option("--tag <tag>", "Release tag to install (default: latest)")
  .option("--path <binary>", "Path to lb executable to replace")
  .action(async (options) => {
    try {
      const result = await runSelfUpdate({
        check: Boolean(options.check),
        force: Boolean(options.force),
        version: options.tag,
        path: options.path,
        onStatus: (status) => output(status.message),
      });

      if (result.alreadyUpdated) {
        output(`lb is up to date (${result.localVersion})`);
        return;
      }

      if (options.check) {
        output(`Update available: ${result.localVersion} -> ${result.remoteVersion}`);
        output(`Release: ${result.releaseUrl}`);
        return;
      }

      output(`Release: ${result.releaseUrl}`);
      output(formatResult(result));
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
