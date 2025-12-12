# lb - Linear-native beads-style CLI

`lb` is a Linear-backed issue tracker CLI inspired by [beads](https://github.com/steveyegge/beads) (`bd`). It provides the same fast, AI-friendly workflow as beads while using Linear as the source of truth.

## Features

- **bd-compatible CLI** - Same commands and flags you know from beads
- **bd-compatible JSON** - snake_case, arrays, terse output
- **Offline-first** - Local SQLite cache + outbox queue
- **Repo scoping** - Issues filtered by `repo:name` label
- **No daemon** - Explicit `lb sync` command

## Installation

```bash
# Clone and install
git clone <repo>
cd lb-cli
bun install

# Run directly
bun run src/cli.ts --help

# Or build and link globally
bun run build
npm link
```

## Configuration

Set your Linear API key:

```bash
export LINEAR_API_KEY=lin_api_xxxxx
export LB_TEAM_KEY=MYTEAM  # Your Linear team key
```

Or create `.lb.json`:

```json
{
  "api_key": "lin_api_xxxxx",
  "team_key": "MYTEAM"
}
```

## Quick Start

```bash
# Verify connection
lb whoami

# Sync with Linear
lb sync

# List issues
lb list --json

# Show ready (unblocked) issues
lb ready --json

# Create an issue
lb create "Fix login bug" -t bug -p 1 --json

# Update status
lb update TEAM-123 --status in_progress --json

# Close an issue
lb close TEAM-123 --reason "Fixed in commit abc123" --json
```

## Commands

| Command | Description |
|---------|-------------|
| `lb list` | List all issues |
| `lb ready` | List unblocked issues |
| `lb show <id>` | Show issue details |
| `lb create <title>` | Create new issue |
| `lb update <id>` | Update issue |
| `lb close <id>` | Close issue |
| `lb sync` | Push/pull with Linear |
| `lb onboard` | Output agent instructions |
| `lb whoami` | Verify API connection |

## Options

All commands support:
- `-j, --json` - Output as JSON (bd-compatible format)
- `--sync` - Force immediate sync (don't queue)
- `--team <key>` - Override team key

### create options
- `-t, --type <type>` - bug, feature, task, epic, chore
- `-p, --priority <n>` - 0 (critical) to 4 (backlog)
- `-d, --description <desc>` - Issue description
- `--parent <id>` - Parent issue for subtasks
- `--deps <deps>` - Dependencies (e.g., `discovered-from:TEAM-123`)

### update options
- `-s, --status <status>` - open, in_progress, closed
- `-p, --priority <n>` - 0-4
- `--title <title>` - New title
- `-d, --description <desc>` - New description

### list/ready options
- `-s, --status <status>` - Filter by status
- `-p, --priority <n>` - Filter by priority
- `-t, --type <type>` - Filter by type

## Architecture

```
lb-cli/
├── src/
│   ├── cli.ts              # Main entry point
│   ├── types.ts            # Core types + Linear mappings
│   ├── commands/           # CLI commands
│   │   ├── list.ts
│   │   ├── ready.ts
│   │   ├── show.ts
│   │   ├── create.ts
│   │   ├── update.ts
│   │   ├── close.ts
│   │   ├── sync.ts
│   │   └── onboard.ts
│   └── utils/
│       ├── config.ts       # Config loading
│       ├── database.ts     # SQLite cache + outbox
│       ├── graphql.ts      # Linear API client
│       ├── linear.ts       # Linear operations
│       ├── output.ts       # JSON formatting
│       └── sync.ts         # Sync logic
└── .lb/
    └── cache.db            # Local SQLite (git-ignored)
```

## How it Works

1. **Cache**: Issues are cached locally in SQLite (`.lb/cache.db`)
2. **Outbox**: Write commands queue mutations locally
3. **Sync**: `lb sync` pushes outbox then pulls from Linear
4. **Scoping**: All issues are filtered by `repo:<name>` label

## Differences from beads

| Feature | beads (bd) | lb |
|---------|------------|-----|
| Storage | Local JSONL | Linear API |
| Sync | Auto-daemon | Manual `lb sync` |
| IDs | `bd-xxx` | `TEAM-123` |
| Offline | Full | Cache only |

## Linear Primitives Used

All free-tier compatible:
- Issues (create, update, list)
- Labels (repo scoping, issue types)
- Workflow states (status mapping)
- Issue relations (blocks, related)
- Comments (close reasons)

## For AI Agents

Run `lb onboard` to get agent instructions, or see the generated markdown for:
- Workflow patterns
- Command quick-reference
- Priority/type mappings

## License

MIT
