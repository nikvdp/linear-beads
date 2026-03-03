import { Command } from "commander";
import { homedir } from "os";
import { join } from "path";
import { output, outputError } from "../utils/output.js";
import {
  getPackagedSkill,
  installPackagedSkill,
  listPackagedSkills,
} from "../utils/skill-factory.js";

export const skillCommand = new Command("skill").description(
  "List, emit, and install packaged lb skills"
);

const TARGET_PATHS = {
  claude: join(homedir(), ".claude", "skills"),
  codex: join(homedir(), ".codex", "skills"),
  pi: join(homedir(), ".pi", "agent", "skills"),
} as const;

function resolveInstallRoots(options: {
  dir?: string;
  claude?: boolean;
  codex?: boolean;
  pi?: boolean;
}): string[] {
  const roots: string[] = [];
  if (options.dir) roots.push(options.dir);
  if (options.claude) roots.push(TARGET_PATHS.claude);
  if (options.codex) roots.push(TARGET_PATHS.codex);
  if (options.pi) roots.push(TARGET_PATHS.pi);
  return [...new Set(roots)];
}

skillCommand
  .command("list")
  .description("List packaged skills embedded in lb")
  .action(() => {
    const skills = listPackagedSkills();
    output("Packaged skills:");
    for (const skill of skills) {
      output(`- ${skill.name}: ${skill.description}`);
    }
    output("");
    output("Convenience install targets:");
    output(`- --claude -> ${TARGET_PATHS.claude}`);
    output(`- --codex  -> ${TARGET_PATHS.codex}`);
    output(`- --pi     -> ${TARGET_PATHS.pi}`);
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
  .option("--dir <path>", "Skills directory root (contains skill folders)")
  .option("--claude", "Install to ~/.claude/skills")
  .option("--codex", "Install to ~/.codex/skills")
  .option("--pi", "Install to ~/.pi/agent/skills")
  .action((name: string, options) => {
    const roots = resolveInstallRoots(options);
    if (roots.length === 0) {
      outputError("Specify at least one target with --dir, --claude, --codex, or --pi.");
      process.exit(1);
    }

    const names =
      name === "all" ? listPackagedSkills().map((skill) => skill.name) : [name as string];

    for (const root of roots) {
      output(`Installing to ${root}`);
      for (const skillName of names) {
        const skill = getPackagedSkill(skillName);
        if (!skill) {
          outputError(`Unknown skill: ${skillName}`);
          process.exit(1);
        }

        const installedDir = installPackagedSkill(skill, root);
        output(`Installed ${skill.name} -> ${installedDir}`);
      }
    }
  });
