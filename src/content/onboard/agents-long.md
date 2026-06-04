## CRITICAL: Task Tracking with `lb`

> **STOP. READ THIS CAREFULLY.**
>
> **DO NOT use your built-in todo/task tracking tools for this repo.**
> **No todo lists, no task trackers, no scratchpads - ONLY `lb`.**
>
> Need to track subtasks or steps? Create subissues:
> ```bash
> lb create "Step 1: ..." --parent LIN-XXX
> lb create "Step 2: ..." --parent LIN-XXX
> ```
>
> `lb` IS your todo list. There is no other.

This repo uses `lb` for all task management. All tasks live in Linear.

### Quick Start

```bash
lb sync                    # Pull latest from Linear
lb ready                   # See unblocked work (issues with no blockers)
lb show LIN-XXX            # Read full description before starting
lb update LIN-XXX --status in_progress   # Claim it
```

### Dependencies & Blocking

`lb` tracks relationships between issues. `lb ready` only shows unblocked issues.

```bash
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
lb dep tree LIN-A          # Visualize children and blocker order
```

**Dependency types:**
- `--blocks ID` - This issue must finish before ID can start
- `--blocked-by ID` - This issue can't start until ID finishes
- `--related ID` - Soft link, doesn't block progress
- `--discovered-from ID` - Found while working on ID (creates relation)

### Multiline Descriptions (Important)

Avoid literal escaped newlines like `"line1\\nline2"` in descriptions.
For long text, prefer writing a temp file and passing it with `@file`:

```bash
body_file=$(mktemp)
cat <<'EOF' >"$body_file"
Why

Details...
EOF
lb create "Title" -d "@$body_file"
```

Also supported:
- `--description-file <path>`
- `--description-stdin`
- inline `-d @path` and `lb update ID -d @path`
- default auto-heal for accidental `\\n` sequences, with `--no-auto-format-escaped-newlines` as an escape hatch

`lb` auto-corrects likely accidental escaped newlines and prints a loud warning so agents stop doing it.

For other long body-like flags, use the same pattern:
- `lb close ID --reason @reason.md`

### Token-Saving Body Edits

When a ticket body is long, do not read it as JSON and do not resend the whole thing from the model.

```bash
lb show LIN-XXX --body
lb update LIN-XXX --replace "old text" --with "new text"
```

For larger chunks, put the exact old and new text in files and use `@file` indirection:

```bash
lb update LIN-XXX --replace @old.md --with @new.md
```

Rules:
- `lb show --body` prints only the normalized body text, with no JSON escaping or metadata noise
- `lb update --replace ... --with ...` matches against that same shown body surface
- every `--replace` must pair with the next `--with`; unmatched flags fail loudly
- replacements must match exactly once; zero or multiple matches fail loudly
- `lb` still rewrites and queues the full updated description on the outbox, but this flow saves agent tokens, which are the scarce resource

### Remote IDs: default local-first, opt into `--wait` only when needed

Most agent workflows should stay local-first:
- create issues normally and keep using the returned local id
- build parent, blocker, and related graphs with those local ids
- let background sync resolve them later

Use `lb create --wait` only when a script truly needs a resolved remote `LIN-*` immediately:

```bash
lb create "Needs remote id now" --wait --json
lb create "Short budget" --wait --wait-timeout-ms 5000 --json
```

Wait contract:
- success returns normal issue output with a resolved `LIN-*` id
- timeout exits non-zero and includes the preserved local id
- paused or offline waits also exit non-zero
- local-only repos reject `--wait`

### Planning Work (SUBISSUES, NOT BUILT-IN TODOS)

When you need to break down a task into steps, **create subissues in lb**:

```bash
lb create "Step 1: Do X" --parent LIN-XXX -d "Details..."
lb create "Step 2: Do Y" --parent LIN-XXX -d "Details..."
lb create "Step 3: Do Z" --parent LIN-XXX --blocked-by LIN-YYY  # If order matters
```

Prefer hierarchy and encapsulation:
- one parent issue for the overall outcome
- child issues for independently executable implementation units
- deeper descendants only when a child still hides multiple real steps

Use blockers to encode execution order:
- if one child must land before another, express that with `--blocked-by` or `--blocks`
- if work can proceed in parallel, leave the sibling issues unblocked
- another agent should be able to run `lb ready` and see the intended next step
- run `lb dep tree <parent>` and check `Children (execution order)` before claiming child work

Write implementation tickets so another agent can execute them without re-planning the whole change. Good tickets should include:
- why the work exists and the exact behavior change
- non-goals so scope stays bounded
- likely files, functions, commands, or modules to edit
- concrete implementation notes, not vague handwaves
- validation steps and important edge cases

**Why subissues instead of your built-in task tools?**
- Subissues persist across sessions - built-in todos don't
- Other agents and humans can see them in Linear
- Dependencies are tracked properly
- Work doesn't get lost or duplicated

### Workflow

1. `lb ready` - Find unblocked work
2. `lb update ID --status in_progress` - Claim it
3. Work on it
4. Found new issue? `lb create "Found: X" --discovered-from ID`
5. `lb close ID --reason "Done"`

### Viewing Issues

```bash
lb list                    # All issues
lb list --status open      # Filter by status
lb ready                   # Unblocked issues ready to work
lb blocked                 # Blocked issues (shows what's blocking them)
lb show LIN-XXX            # Full details with all relationships
```

### One-Off Scope Overrides (Non-Repo Work)

For temporary structured work that should not modify repo config:

```bash
# One command only
lb --temp-name oneoff-planning --temp-name-mode label list

# Session-level override
export LB_TEMP_NAME=oneoff-planning
export LB_TEMP_NAME_MODE=project
lb create "Plan migration" --sync
```

Precedence: CLI temp flags > env temp vars > config > git heuristic.

### Key Commands

| Command | Purpose |
|---------|---------|
| `lb sync` | Sync with Linear |
| `lb ready` | Show unblocked issues |
| `lb blocked` | Show blocked issues with blockers |
| `lb show ID` | Full issue details + relationships |
| `lb create "Title" -d "..."` | Create issue |
| `lb create "Title" --parent ID` | Create subtask |
| `lb create "Title" --blocked-by ID` | Create blocked issue |
| `lb update ID --status in_progress` | Claim work |
| `lb close ID --reason "why"` | Complete work |
| `lb dep add ID --blocks OTHER` | Add blocking dependency |
| `lb dep tree ID` | Show children and blocker order |

### Rules

1. **NEVER use built-in task/todo tools** - ONLY `lb`
   - Not for planning, not for tracking, not for anything
   - Your memory can be wiped - `lb` tickets are persistent
   - If you need subtasks: `lb create "..." --parent LIN-XXX`
   - There is NO exception to this rule
2. **Always `lb sync` then `lb ready`** before asking what to work on
3. **Always `lb show`** to read the full description before starting
4. **Link discovered work** with `--discovered-from` to maintain context graph
5. **Write handoff-ready tickets** with concrete files, edit points, and validation, not vague summaries
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

**Offload everything important to `lb` tickets:**
- Design decisions, context, research findings
- Implementation notes and code snippets  
- Blockers and dependencies
- File paths, symbols, and exact intended edits
- "Where I left off" checkpoints

**Think of `lb` as your persistent brain supplement.** Your memory is cache, `lb` is database.
