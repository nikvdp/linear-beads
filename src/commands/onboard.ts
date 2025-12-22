/**
 * lb onboard - Output agent instructions
 */

import { Command } from "commander";
import { output } from "../utils/output.js";

// Instructions that should be added to AGENTS.md
const AGENTS_MD_CONTENT = `## CRITICAL: Task Tracking with \`lb\`

**DO NOT use built-in todo/task tracking tools. Use \`lb\` instead.**

This repo uses \`lb\` for issue tracking. All tasks live in Linear. The \`lb\` CLI is your todo list - not your built-in task tools.

### Quick Start

\`\`\`bash
lb sync                    # Pull latest from Linear
lb ready                   # See unblocked work (issues with no blockers)
lb show LIN-XXX            # Read full description before starting
lb update LIN-XXX --status in_progress   # Claim it
\`\`\`

### Dependencies & Blocking

\`lb\` tracks relationships between issues. \`lb ready\` only shows unblocked issues.

\`\`\`bash
# This issue blocks another (other can't start until this is done)
lb create "Must do first" --blocks LIN-123

# This issue is blocked by another (can't start until other is done)
lb create "Depends on auth" --blocked-by LIN-100

# Found a bug while working on LIN-50? Link it
lb create "Found: race condition" --discovered-from LIN-50 -d "Details..."

# General relation (doesn't block)
lb create "Related work" --related LIN-200

# Manage deps after creation
lb dep add LIN-A --blocks LIN-B
lb dep remove LIN-A LIN-B
lb dep tree LIN-A          # Visualize dependency tree
\`\`\`

**Dependency types:**
- \`--blocks ID\` - This issue must finish before ID can start
- \`--blocked-by ID\` - This issue can't start until ID finishes
- \`--related ID\` - Soft link, doesn't block progress
- \`--discovered-from ID\` - Found while working on ID (creates relation)

### Planning Work

Break down tasks into subtasks:

\`\`\`bash
lb create "Step 1: Do X" --parent LIN-XXX -d "Details..."
lb create "Step 2: Do Y" --parent LIN-XXX -d "Details..."
\`\`\`

### Workflow

1. \`lb ready\` - Find unblocked work
2. \`lb update ID --status in_progress\` - Claim it
3. Work on it
4. Found new issue? \`lb create "Found: X" --discovered-from ID\`
5. \`lb close ID --reason "Done"\`

### Viewing Issues

\`\`\`bash
lb list                    # All issues
lb list --status open      # Filter by status
lb ready                   # Unblocked issues ready to work
lb blocked                 # Blocked issues (shows what's blocking them)
lb show LIN-XXX            # Full details with all relationships
\`\`\`

### Key Commands

| Command | Purpose |
|---------|---------|
| \`lb sync\` | Sync with Linear |
| \`lb ready\` | Show unblocked issues |
| \`lb blocked\` | Show blocked issues with blockers |
| \`lb show ID\` | Full issue details + relationships |
| \`lb create "Title" -d "..."\` | Create issue |
| \`lb create "Title" --parent ID\` | Create subtask |
| \`lb create "Title" --blocked-by ID\` | Create blocked issue |
| \`lb update ID --status in_progress\` | Claim work |
| \`lb close ID --reason "why"\` | Complete work |
| \`lb dep add ID --blocks OTHER\` | Add blocking dependency |
| \`lb dep tree ID\` | Show dependency tree |

### Rules

1. **NEVER use built-in task tools** - use \`lb create\` for subtasks
2. **Always \`lb ready\`** before asking what to work on
3. **Always \`lb show\`** to read the full description before starting
4. **Link discovered work** with \`--discovered-from\` to maintain context graph
5. **Include descriptions** with enough context for handoff
6. **Close with reasons** explaining what was done`;

const ONBOARD_CONTENT = `# lb Onboard

This repo uses \`lb\` for Linear-backed issue tracking.

## Your Task

**Add the following to this repo's AGENTS.md file** (create it if it doesn't exist).
This ensures all future agents know to use \`lb\`:

---

${AGENTS_MD_CONTENT}

---

After adding the above to AGENTS.md, run \`lb sync\` then \`lb ready\` to find work.
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
