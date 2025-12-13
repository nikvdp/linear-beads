/**
 * lb onboard - Output agent instructions
 */

import { Command } from "commander";
import { output } from "../utils/output.js";

// Instructions that should be added to AGENTS.md
const AGENTS_MD_CONTENT = `## lb - Issue Tracking

This repo uses \`lb\` for issue tracking. All tasks live in Linear.

### Workflow

1. \`lb ready --json\` - see your unblocked work
2. \`lb update <id> --status in_progress\` - claim it
3. Do the work
4. \`lb close <id> --reason "Done"\` - mark complete

### Creating Issues

\`\`\`bash
lb create "Title" -p 1 -d "Description with context"
lb create "Bug" -t bug -p 1 -d "Steps to reproduce, expected vs actual"
lb create "Subtask" --parent LIN-123 -d "Why this is needed"
lb create "Found this" --deps discovered-from:LIN-123 -d "Context from parent"
\`\`\`

**Always include a description (-d)** with enough context for another agent to pick up the task:
- What needs to be done and why
- Relevant file paths or code references
- Any constraints or acceptance criteria

### Key Commands

- \`lb ready\` - unblocked issues assigned to you (or unassigned)
- \`lb list\` - all issues
- \`lb show LIN-123\` - issue details with description
- \`lb update LIN-123 --status in_progress\` - update status
- \`lb close LIN-123 --reason "why"\` - close with reason

### Rules

- Use \`lb\` for ALL task tracking - no markdown TODOs
- Always include descriptions with context for handoff
- Check \`lb ready\` before asking what to work on
- Link discovered work with \`--deps discovered-from:<id>\``;

const ONBOARD_CONTENT = `# lb Onboard

This repo uses \`lb\` for Linear-backed issue tracking.

## Your Task

**Add the following to this repo's AGENTS.md file** (create it if it doesn't exist).
This ensures all future agents know to use \`lb\`:

---

${AGENTS_MD_CONTENT}

---

## Quick Reference

\`\`\`bash
lb ready --json              # Your unblocked work
lb update LIN-X --status in_progress
lb create "New issue" -p 1
lb close LIN-X --reason "Done"
\`\`\`

After adding the above to AGENTS.md, you're ready to use \`lb ready\` to find work.
`;

export const onboardCommand = new Command("onboard")
  .description("Output agent instructions for lb")
  .option("-o, --output <file>", "Write to file instead of stdout")
  .action(async (options) => {
    if (options.output) {
      const { writeFileSync } = await import("fs");
      writeFileSync(options.output, ONBOARD_CONTENT);
      output(`Written to ${options.output}`);
    } else {
      output(ONBOARD_CONTENT);
    }
  });
