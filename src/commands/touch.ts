/**
 * lb touch - Round-trip an issue through lb's canonical description codec
 */

import { Command } from "commander";
import { getDisplayId, isLocalId, resolveIssueId } from "../utils/database.js";
import { getTeamId, updateIssue } from "../utils/issue-backend.js";
import {
  formatIssueJson,
  formatIssueHuman,
  formatIssueHumanBeads,
  output,
  outputError,
} from "../utils/output.js";
import {
  getHumanOutputStyle,
  HUMAN_OUTPUT_STYLE_CHOICES,
  isLocalOnly,
  parseHumanOutputStyle,
} from "../utils/config.js";

export const touchCommand = new Command("touch")
  .description("Round-trip an issue through lb's canonical description heal path")
  .argument("<id>", "Issue ID")
  .option("-j, --json", "Output as JSON")
  .option("--style <style>", `Human output style: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`)
  .option("--team <team>", "Team key (overrides config)")
  .action(async (id: string, options) => {
    try {
      const requestedStyle = options.style ? parseHumanOutputStyle(options.style) : undefined;
      if (options.style && !requestedStyle) {
        console.error(
          `Invalid style '${options.style}'. Must be one of: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`
        );
        process.exit(1);
      }

      const resolvedId = resolveIssueId(id);

      if (isLocalOnly()) {
        outputError("touch is unavailable in local-only mode");
        process.exit(1);
      }

      if (isLocalId(resolvedId)) {
        outputError(`Issue not synced yet: ${id}`);
        process.exit(1);
      }

      const teamId = await getTeamId(options.team);
      const issue = await updateIssue(resolvedId, {}, teamId);

      if (options.json) {
        output(formatIssueJson(issue));
      } else {
        const style = getHumanOutputStyle(requestedStyle);
        output(
          style === "beads"
            ? formatIssueHumanBeads(issue, getDisplayId(issue.id))
            : formatIssueHuman(issue, getDisplayId(issue.id))
        );
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
