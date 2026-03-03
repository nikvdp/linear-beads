import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export interface PackagedSkill {
  name: string;
  description: string;
  skillMd: string;
  openaiYaml: string;
}

const LB_BASIC_USAGE_SKILL_MD = `---
name: lb-basic-usage
description: Use lb as the primary task tracker in Linear-backed repos. Use when claiming work, creating dependencies/subissues, updating status, closing work, or avoiding ephemeral built-in todo tools.
---

# lb Basic Usage

Use \`lb\` as the source of truth for task tracking in this repo.

## Core loop

1. Run \`lb sync\`.
2. Run \`lb ready\`.
3. Open the ticket with \`lb show <id>\`.
4. Claim it with \`lb update <id> --status in_progress\`.
5. Do the work.
6. Close with \`lb close <id> --reason "..."\`.

## Dependencies and decomposition

- Create dependent work with \`--blocks\` and \`--blocked-by\`.
- Create subissues with \`--parent\`.
- Link discovered work with \`--discovered-from\`.
- Use \`lb dep tree <id>\` to verify order.

## Multiline descriptions

Avoid literal escaped \`\\n\` in issue descriptions.
Use heredoc text, \`--description-file\`, or \`--description-stdin\`.
If needed, use \`--auto-format-escaped-newlines\` when rewriting.

## Useful commands

\`lb list\`, \`lb ready\`, \`lb blocked\`, \`lb show <id>\`, \`lb create\`, \`lb update\`, \`lb close\`, \`lb dep add\`.
`;

const LB_EXECUTION_LOOP_SKILL_MD = `---
name: lb-execution-loop
description: Plan and execute Linear/lb work with a strict claim-code-commit-close loop. Use when splitting work into parent/children with blockers and shipping each child in order.
---

# LB Execution Loop

## Setup

1. Create or identify one parent issue.
2. Create child issues for each implementation unit.
3. Encode sequence with blocker links.

## Execution contract

For each child issue, in order:

1. Claim: \`lb update <id> --status in_progress\`
2. Code: implement only that issue scope
3. Commit: atomic commits for completed logical changes
4. Close: \`lb close <id> --reason "..."\`

## Ticket quality bar

Each issue should include:

- Why: problem and user impact
- What: exact behavior change and non-goals
- Where: concrete file paths
- How: implementation approach
- Validation: checks to run and success criteria

## Notes

- Do not batch status changes at end of day.
- Keep dependencies explicit in lb, not only in prose.
- Keep changes scoped to the claimed issue.
`;

const LB_BASIC_USAGE_OPENAI_YAML = `display_name: LB Basic Usage
short_description: Use lb as the persistent task tracker and dependency graph.
default_prompt: Use this skill to follow lb-first task tracking and issue lifecycle workflows.
`;

const LB_EXECUTION_LOOP_OPENAI_YAML = `display_name: LB Execution Loop
short_description: Run claim-code-commit-close issue execution with blockers.
default_prompt: Use this skill to structure and execute lb work through ordered parent/child issues.
`;

const PACKAGED_SKILLS: Record<string, PackagedSkill> = {
  "lb-basic-usage": {
    name: "lb-basic-usage",
    description: "lb-first tracking workflow and core command usage",
    skillMd: LB_BASIC_USAGE_SKILL_MD,
    openaiYaml: LB_BASIC_USAGE_OPENAI_YAML,
  },
  "lb-execution-loop": {
    name: "lb-execution-loop",
    description: "parent/child planning and claim-code-commit-close execution",
    skillMd: LB_EXECUTION_LOOP_SKILL_MD,
    openaiYaml: LB_EXECUTION_LOOP_OPENAI_YAML,
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
