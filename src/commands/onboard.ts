/**
 * lb onboard - Output agent instructions
 */

import { Command } from "commander";
import { output, outputError } from "../utils/output.js";
import agentsLong from "../content/onboard/agents-long.md" with { type: "text" };
import agentsShort from "../content/onboard/agents-short.md" with { type: "text" };
import wrapperTemplate from "../content/onboard/wrapper.md" with { type: "text" };

const AGENTS_MD_LONG = agentsLong;
const AGENTS_MD_SHORT = agentsShort;

function buildOnboardContent(mode: "long" | "short"): string {
  const agentsMdBlock = mode === "long" ? AGENTS_MD_LONG : AGENTS_MD_SHORT;
  return wrapperTemplate.replace("{{AGENTS_MD_BLOCK}}", agentsMdBlock);
}

export const onboardCommand = new Command("onboard")
  .description("Output agent instructions for lb")
  .option("--short", "Use compact onboarding content")
  .option("--long", "Use full onboarding content (default)")
  .option("--agents-md", "Emit only the agents.md-ready block")
  .option("-o, --output <file>", "Write to file instead of stdout")
  .action(async (options) => {
    if (options.short && options.long) {
      outputError("Use only one of --short or --long.");
      process.exit(1);
    }

    const mode: "long" | "short" = options.short ? "short" : "long";
    const content = options.agentsMd
      ? mode === "long"
        ? AGENTS_MD_LONG
        : AGENTS_MD_SHORT
      : buildOnboardContent(mode);

    if (options.output) {
      const { writeFileSync } = await import("fs");
      writeFileSync(options.output, content);
      output(`Written to ${options.output}`);
    } else {
      output(content);
    }
  });
