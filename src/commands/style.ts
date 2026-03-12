/**
 * lb style - Get or set the default human output style
 */

import { Command } from "commander";
import {
  getHumanOutputStyle,
  HUMAN_OUTPUT_STYLE_CHOICES,
  parseHumanOutputStyle,
  writeGlobalConfig,
  writeRepoConfig,
} from "../utils/config.js";
import { output } from "../utils/output.js";

export const styleCommand = new Command("style")
  .description("Get or set the default human output style for list and ready")
  .argument("[style]", `One of: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`)
  .option("--global", "Persist the default to global config")
  .option("--repo", "Persist the default to repo config (default)")
  .action((style, options) => {
    if (!style) {
      output(`Current human output style: ${getHumanOutputStyle()}`);
      return;
    }

    const parsedStyle = parseHumanOutputStyle(style);
    if (!parsedStyle) {
      console.error(
        `Invalid style '${style}'. Must be one of: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`
      );
      process.exit(1);
    }

    if (options.global && options.repo) {
      console.error("Choose either --global or --repo, not both.");
      process.exit(1);
    }

    const configPath = options.global
      ? writeGlobalConfig({ human_output_style: parsedStyle })
      : writeRepoConfig({ human_output_style: parsedStyle });

    output(`Default human output style set to ${parsedStyle}.`);
    output(`Saved to ${configPath}`);
  });
