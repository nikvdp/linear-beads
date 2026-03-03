import { Command } from "commander";
import { output, outputError } from "../utils/output.js";
import {
  getPackagedSkill,
  installPackagedSkill,
  listPackagedSkills,
} from "../utils/skill-factory.js";

export const skillCommand = new Command("skill").description(
  "List, emit, and install packaged lb skills"
);

skillCommand
  .command("list")
  .description("List packaged skills embedded in lb")
  .action(() => {
    const skills = listPackagedSkills();
    output("Packaged skills:");
    for (const skill of skills) {
      output(`- ${skill.name}: ${skill.description}`);
    }
  });

skillCommand
  .command("emit")
  .description("Print packaged skill content")
  .argument("<name>", "Skill name (or 'all')")
  .option("--format <format>", "Output format: skill-md or openai-yaml", "skill-md")
  .action((name: string, options) => {
    const format = options.format as string;
    if (format !== "skill-md" && format !== "openai-yaml") {
      outputError("Invalid --format. Use 'skill-md' or 'openai-yaml'.");
      process.exit(1);
    }

    const names =
      name === "all" ? listPackagedSkills().map((skill) => skill.name) : [name as string];

    for (const skillName of names) {
      const skill = getPackagedSkill(skillName);
      if (!skill) {
        outputError(`Unknown skill: ${skillName}`);
        process.exit(1);
      }

      if (names.length > 1) {
        output(`### ${skill.name} (${format})`);
      }
      output(format === "skill-md" ? skill.skillMd : skill.openaiYaml);
    }
  });

skillCommand
  .command("install")
  .description("Install packaged skill(s) to a target skills directory")
  .argument("[name]", "Skill name (or 'all')", "all")
  .requiredOption("--dir <path>", "Skills directory root (contains skill folders)")
  .action((name: string, options) => {
    const names =
      name === "all" ? listPackagedSkills().map((skill) => skill.name) : [name as string];

    for (const skillName of names) {
      const skill = getPackagedSkill(skillName);
      if (!skill) {
        outputError(`Unknown skill: ${skillName}`);
        process.exit(1);
      }

      const installedDir = installPackagedSkill(skill, options.dir as string);
      output(`Installed ${skill.name} -> ${installedDir}`);
    }
  });
