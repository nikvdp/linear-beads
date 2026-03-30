import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import lbBasicUsageSkillMd from "../content/skills/lb-basic-usage/SKILL.md" with { type: "text" };
import lbBasicUsageOpenAiYaml from "../content/skills/lb-basic-usage/agents/openai.yaml" with { type: "text" };
import lbExecutionLoopSkillMd from "../content/skills/lb-execution-loop/SKILL.md" with { type: "text" };
import lbExecutionLoopOpenAiYaml from "../content/skills/lb-execution-loop/agents/openai.yaml" with { type: "text" };

export interface PackagedSkill {
  name: string;
  description: string;
  skillMd: string;
  openaiYaml: string;
}

function parseFrontmatterValue(markdown: string, key: string): string {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error(`Missing frontmatter in packaged skill for key '${key}'.`);
  }

  const line = match[1].split("\n").find((entry) => entry.startsWith(`${key}:`));

  if (!line) {
    throw new Error(`Missing frontmatter key '${key}' in packaged skill.`);
  }

  return line.slice(key.length + 1).trim();
}

const PACKAGED_SKILLS: Record<string, PackagedSkill> = {
  "lb-basic-usage": {
    name: parseFrontmatterValue(lbBasicUsageSkillMd, "name"),
    description: parseFrontmatterValue(lbBasicUsageSkillMd, "description"),
    skillMd: lbBasicUsageSkillMd,
    openaiYaml: lbBasicUsageOpenAiYaml,
  },
  "lb-execution-loop": {
    name: parseFrontmatterValue(lbExecutionLoopSkillMd, "name"),
    description: parseFrontmatterValue(lbExecutionLoopSkillMd, "description"),
    skillMd: lbExecutionLoopSkillMd,
    openaiYaml: lbExecutionLoopOpenAiYaml,
  },
};

export function listPackagedSkills(): PackagedSkill[] {
  return Object.values(PACKAGED_SKILLS);
}

export function getPackagedSkill(name: string): PackagedSkill | null {
  return PACKAGED_SKILLS[name] || null;
}

export function installPackagedSkill(skill: PackagedSkill, skillsRootDir: string): string {
  const skillDir = join(skillsRootDir, skill.name);
  const agentsDir = join(skillDir, "agents");

  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), skill.skillMd);
  writeFileSync(join(agentsDir, "openai.yaml"), skill.openaiYaml);

  return skillDir;
}
