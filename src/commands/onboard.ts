/**
 * lb onboard - Output agent instructions
 */

import { Command } from "commander";
import { output } from "../utils/output.js";

const ONBOARD_CONTENT = `## Issue Tracking with lb

**IMPORTANT**: This project uses **lb** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why lb?

- Linear-backed: Issues sync with Linear for visibility and collaboration
- Dependency-aware: Track blockers and relationships between issues
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Repo-scoped: Only see issues relevant to this repository
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**
\`\`\`bash
lb ready --json
\`\`\`

**Create new issues:**
\`\`\`bash
lb create "Issue title" -t bug|feature|task -p 0-4 --json
lb create "Issue title" -p 1 --deps discovered-from:LIN-123 --json
lb create "Subtask" --parent LIN-123 --json
\`\`\`

**Claim and update:**
\`\`\`bash
lb update LIN-42 --status in_progress --json
lb update LIN-42 --priority 1 --json
\`\`\`

**Complete work:**
\`\`\`bash
lb close LIN-42 --reason "Completed" --json
\`\`\`

### Issue Types

- \`bug\` - Something broken
- \`feature\` - New functionality
- \`task\` - Work item (tests, docs, refactoring)
- \`epic\` - Large feature with subtasks
- \`chore\` - Maintenance (dependencies, tooling)

### Priorities

- \`0\` - Critical (security, data loss, broken builds)
- \`1\` - High (major features, important bugs)
- \`2\` - Medium (default, nice-to-have)
- \`3\` - Low (polish, optimization)
- \`4\` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: \`lb ready --json\` shows unblocked issues
2. **Claim your task**: \`lb update <id> --status in_progress --json\`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - \`lb create "Found bug" -p 1 --deps discovered-from:<parent-id> --json\`
5. **Complete**: \`lb close <id> --reason "Done" --json\`
6. **Sync**: Run \`lb sync\` to push changes to Linear

### Syncing with Linear

lb caches issues locally for fast access. To push pending changes and pull latest:
\`\`\`bash
lb sync
\`\`\`

Commands also accept \`--sync\` to push immediately instead of queuing.

### CLI Help

Run \`lb <command> --help\` to see all available flags for any command.
For example: \`lb create --help\` shows \`--parent\`, \`--deps\`, \`--type\`, etc.

### Important Rules

- Use lb for ALL task tracking
- Always use \`--json\` flag for programmatic use
- Link discovered work with \`--deps discovered-from:<id>\`
- Check \`lb ready\` before asking "what should I work on?"
- Run \`lb sync\` to persist changes to Linear
- Do NOT create markdown TODO lists
- Do NOT use external issue trackers
- Do NOT duplicate tracking systems
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
