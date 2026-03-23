/**
 * lb onboard - Output agent instructions
 */

import { Command } from "commander";
import { output, outputError } from "../utils/output.js";

const AGENTS_MD_LONG = `## CRITICAL: Task Tracking with \`lb\`

> **STOP. READ THIS CAREFULLY.**
>
> **DO NOT use your built-in todo/task tracking tools for this repo.**
> **No todo lists, no task trackers, no scratchpads - ONLY \`lb\`.**
>
> Need to track subtasks or steps? Create subissues:
> \`\`\`bash
> lb create "Step 1: ..." --parent LIN-XXX
> lb create "Step 2: ..." --parent LIN-XXX
> \`\`\`
>
> \`lb\` IS your todo list. There is no other.

This repo uses \`lb\` for all task management. All tasks live in Linear.

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

### Multiline Descriptions (Important)

Avoid literal escaped newlines like \`"line1\\\\nline2"\` in descriptions.
Use real multiline input instead:

\`\`\`bash
desc=$(cat <<'EOF'
Why

Details...
EOF
)
lb create "Title" -d "$desc"
\`\`\`

Also supported:
- \`--description-file <path>\`
- \`--description-stdin\`
- default auto-heal for accidental \`\\\\n\` sequences, with \`--no-auto-format-escaped-newlines\` as an escape hatch

\`lb\` auto-corrects likely accidental escaped newlines and prints a loud warning so agents stop doing it.

### Token-Saving Body Edits

When a ticket body is long, do not read it as JSON and do not resend the whole thing from the model.

\`\`\`bash
lb show LIN-XXX --body
lb update LIN-XXX --replace "old text" "new text"
\`\`\`

For larger chunks, put the exact old and new text in files and use \`@file\` indirection:

\`\`\`bash
lb update LIN-XXX --replace @old.md @new.md
\`\`\`

Rules:
- \`lb show --body\` prints only the normalized body text, with no JSON escaping or metadata noise
- \`lb update --replace\` matches against that same shown body surface
- replacements must match exactly once; zero or multiple matches fail loudly
- \`lb\` still rewrites and queues the full updated description on the outbox, but this flow saves agent tokens, which are the scarce resource

### Remote IDs: default local-first, opt into \`--wait\` only when needed

Most agent workflows should stay local-first:
- create issues normally and keep using the returned local id
- build parent, blocker, and related graphs with those local ids
- let background sync resolve them later

Use \`lb create --wait\` only when a script truly needs a resolved remote \`LIN-*\` immediately:

\`\`\`bash
lb create "Needs remote id now" --wait --json
lb create "Short budget" --wait --wait-timeout-ms 5000 --json
\`\`\`

Wait contract:
- success returns normal issue output with a resolved \`LIN-*\` id
- timeout exits non-zero and includes the preserved local id
- paused or offline waits also exit non-zero
- local-only repos reject \`--wait\`

### Agent Mail Identity Model

Mail handles are local-first identities, not automatically global usernames.

Without a shared Linear directory:
- \`lb agent register --handle Alpha\` keeps a local handle when available
- \`lb agent list\` shows the local cache only
- \`lb mail send --to Beta\` only works if \`Beta\` already exists in the same repo cache

With \`mail_backend: "linear"\`, \`issue_backend: "linear"\`, and \`mail_registry_work_item\` configured:
- \`lb agent register --handle Alpha\` may return a final allocated handle like \`Alpha-ab12\`
- that final returned handle is the one to use for \`--from\`, \`--to\`, scripts, and handoffs
- \`lb agent list\` refreshes the shared directory before listing cached identities
- \`lb mail send\` can resolve unknown local handles through the shared directory

Safe failure modes:
- if \`mail_registry_work_item\` is missing, cross-client lookup fails with an explicit config hint
- if the directory is unavailable, local mail still persists and remote sync can retry later
- local-only mode never claims local handles are globally discoverable

### Planning Work (SUBISSUES, NOT BUILT-IN TODOS)

When you need to break down a task into steps, **create subissues in lb**:

\`\`\`bash
lb create "Step 1: Do X" --parent LIN-XXX -d "Details..."
lb create "Step 2: Do Y" --parent LIN-XXX -d "Details..."
lb create "Step 3: Do Z" --parent LIN-XXX --blocked-by LIN-YYY  # If order matters
\`\`\`

**Why subissues instead of your built-in task tools?**
- Subissues persist across sessions - built-in todos don't
- Other agents and humans can see them in Linear
- Dependencies are tracked properly
- Work doesn't get lost or duplicated

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

### One-Off Scope Overrides (Non-Repo Work)

For temporary structured work that should not modify repo config:

\`\`\`bash
# One command only
lb --temp-name oneoff-planning --temp-name-mode label list

# Session-level override
export LB_TEMP_NAME=oneoff-planning
export LB_TEMP_NAME_MODE=project
lb create "Plan migration" --sync
\`\`\`

Precedence: CLI temp flags > env temp vars > config > git heuristic.

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

1. **NEVER use built-in task/todo tools** - ONLY \`lb\`
   - Not for planning, not for tracking, not for anything
   - Your memory can be wiped - \`lb\` tickets are persistent
   - If you need subtasks: \`lb create "..." --parent LIN-XXX\`
   - There is NO exception to this rule
2. **Always \`lb sync\` then \`lb ready\`** before asking what to work on
3. **Always \`lb show\`** to read the full description before starting
4. **Link discovered work** with \`--discovered-from\` to maintain context graph
5. **Include descriptions** with enough context for handoff
6. **Close with reasons** explaining what was done

### Why No Built-in Task Tools?

- **Built-in task tracking is ephemeral** - disappears when you're restarted
- **Other agents/humans can't see your internal todos** - they're siloed
- **Work gets lost or duplicated** - same task appears multiple times
- **Linear is the persistent source of truth** - everyone sees it

### Critical for AI Agents: Memory is Ephemeral

**Your memory can be wiped at any time.** Without external persistence:
- Critical decisions get lost
- You can't resume work from where you left off
- Other agents start from scratch

**Offload everything important to \`lb\` tickets:**
- Design decisions, context, research findings
- Implementation notes and code snippets  
- Blockers and dependencies
- "Where I left off" checkpoints

**Think of \`lb\` as your persistent brain supplement.** Your memory is cache, \`lb\` is database.
`;

const AGENTS_MD_SHORT = `## Use \`lb\` For Task Tracking

Use \`lb\` as the only task system for this repo. Do not use built-in todo tools.

### Core Loop

\`\`\`bash
lb sync
lb ready
lb show LIN-XXX
lb update LIN-XXX --status in_progress
# do the work
lb close LIN-XXX --reason "Done"
\`\`\`

### Split Work Into Subissues

\`\`\`bash
lb create "Step 1: ..." --parent LIN-XXX
lb create "Step 2: ..." --parent LIN-XXX --blocked-by LIN-YYY
\`\`\`

### Dependency Links

\`\`\`bash
lb create "Must do first" --blocks LIN-123
lb create "Depends on auth" --blocked-by LIN-100
lb create "Found: X" --discovered-from LIN-50 -d "Details..."
lb dep tree LIN-XXX
\`\`\`

### Multiline Descriptions

Do not pass literal \`\\n\` in descriptions. Use real multiline input via heredoc, \`--description-file\`, or \`--description-stdin\`.

### Editing Long Bodies

When changing part of a long ticket body:
- use \`lb show LIN-XXX --body\` to fetch the normalized body text
- use \`lb update LIN-XXX --replace "old" "new"\` for small edits
- use \`lb update LIN-XXX --replace @old.md @new.md\` for large chunks
- \`lb\` still queues the full rewritten body, but this avoids wasting model tokens on full-body rewrites

### Remote IDs

Default to local-first issue creation and keep using the returned local id for normal graph building.
Use \`lb create --wait --json\` only when a script truly needs a resolved remote \`LIN-*\` immediately.

### Agent Mail

If you use shared Linear mail addressing:
- configure \`mail_backend: "linear"\`, \`issue_backend: "linear"\`, and \`mail_registry_work_item\`
- treat the handle returned by \`lb agent register\` as the real address, even if it gained a short suffix
- do not assume repo-local handles are globally discoverable without the shared directory

### Keep Guidance Persistent

- Add this section to repo-level \`AGENTS.md\` or \`CLAUDE.md\`.
- You can also install packaged lb skills:
  - \`lb skill install lb-basic-usage --codex\`
  - \`lb skill install lb-execution-loop --claude\`
`;

function buildOnboardContent(mode: "long" | "short"): string {
  const agentsMdBlock = mode === "long" ? AGENTS_MD_LONG : AGENTS_MD_SHORT;
  return `# lb Onboard

This repo uses \`lb\` for Linear-backed issue tracking.

## Use This Output

Add lb guidance to your instruction file:
- **Claude Code**: CLAUDE.md
- **Other tools**: AGENTS.md

Append if the file exists; create if needed.

Raw block for direct append:

\`\`\`bash
# Full agents.md block (default long)
lb onboard --agents-md >> AGENTS.md

# Explicit short/long variants
lb onboard --agents-md --short >> AGENTS.md
lb onboard --agents-md --long >> AGENTS.md
\`\`\`

Install packaged skills instead of copy/paste:

\`\`\`bash
lb skill list
lb skill install lb-basic-usage --codex
lb skill install lb-execution-loop --claude
lb skill install --all --pi
\`\`\`

Persistence options:

- Repo-local: add to \`./AGENTS.md\` (or \`./CLAUDE.md\` for Claude).
- User-global: add to a global instruction file.
- Skills: install once to a shared skills directory for reuse.

---

${agentsMdBlock}

---

After setup, run \`lb sync\` then \`lb ready\` to find work.
`;
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
