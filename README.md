# lb - Linear-native beads-style CLI

`lb` is a Linear-backed issue tracker CLI inspired by [beads](https://github.com/steveyegge/beads) (`bd`). It provides the same fast, AI-friendly workflow as beads while using Linear as the source of truth.

## Features

- **bd-inspired CLI** - Similar commands and workflow as beads
- **bd-style JSON** - snake_case keys, arrays, terse output for AI agents
- **Offline-first** - Local SQLite cache + outbox queue
- **Repo scoping** - Issues filtered by `repo:name` label
- **Background sync** - Automatic async push to Linear (fire-and-forget)
- **Git-friendly JSONL** - Auto-export to `.lb/issues.jsonl` for version control

## Requirements

- [Bun](https://bun.sh) runtime
- Linear account with API key ([get one here](https://linear.app/settings/api))
- Network access (for syncing to Linear)

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

Three ways to configure (in priority order):

### 1. **Easiest: Use `lb auth`** (Recommended)

```bash
lb auth
# Enter your Linear API key (get one at https://linear.app/settings/api)
# Optionally: lb auth --team MYTEAM
```

Saves to `~/.config/lb/config.json` - works across all projects!

### 2. Environment Variables

```bash
export LINEAR_API_KEY=lin_api_xxxxx
export LB_TEAM_KEY=MYTEAM  # Optional: auto-detected for single-team users
```

Env vars **override** global config.

### 3. Project Config (`.lb.json`)

```json
{
  "api_key": "lin_api_xxxxx",
  "team_key": "MYTEAM"  // Optional
}
```

Project config **overrides** global config but not env vars.

**Config Priority:** `env vars` > `project .lb.json` > `global ~/.config/lb/config.json`

**Team detection:**
- 1 team → Auto-detected
- Multiple teams → Set via `LB_TEAM_KEY`, `--team` flag, or `lb auth --team`

## Quick Start

```bash
# First time: Configure your Linear API key
lb auth

# Initialize lb in your repository
cd your-project
lb init

# Verify and start working
lb whoami
lb ready --json
lb create "My first issue" -t task --json

# Update and close issues (auto-syncs in background)
lb update TEAM-123 --status in_progress --json
lb close TEAM-123 --reason "Done!" --json
```

## Commands

| Command | Description |
|---------|-------------|
| `lb init` | Initialize lb in current repository |
| `lb auth` | Configure Linear API key globally |
| `lb auth --show` | Show current config source and masked key |
| `lb auth --clear` | Remove global config |
| `lb whoami` | Verify API connection and show your teams |
| `lb list` | List all issues (repo-scoped) |
| `lb ready` | List unblocked issues (ready to work) |
| `lb show <id>` | Show issue details |
| `lb create <title>` | Create new issue (auto-syncs in background) |
| `lb update <id>` | Update issue (auto-syncs in background) |
| `lb close <id>` | Close issue (auto-syncs in background) |
| `lb sync` | Manual sync (push/pull with Linear) |
| `lb onboard` | Output agent instructions |

## Options

All commands support:
- `-j, --json` - Output as JSON (bd-style format)
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
│   ├── cli.ts                      # Main entry point
│   ├── types.ts                    # Core types + Linear mappings
│   ├── commands/                   # CLI commands
│   │   ├── list.ts
│   │   ├── ready.ts
│   │   ├── show.ts
│   │   ├── create.ts
│   │   ├── update.ts
│   │   ├── close.ts
│   │   ├── sync.ts
│   │   └── onboard.ts
│   └── utils/
│       ├── config.ts               # Config loading
│       ├── database.ts             # SQLite cache + outbox
│       ├── graphql.ts              # Linear API client
│       ├── linear.ts               # Linear operations
│       ├── output.ts               # JSON formatting
│       ├── sync.ts                 # Sync logic
│       ├── pid-manager.ts          # Background worker PID management
│       ├── background-sync-worker.ts  # Background sync worker
│       ├── spawn-worker.ts         # Worker spawning helper
│       └── jsonl.ts                # JSONL export
└── .lb/
    ├── cache.db                    # Local SQLite (git-ignored)
    ├── sync.pid                    # Worker PID (git-ignored)
    └── issues.jsonl                # JSONL snapshot (git-tracked)
```

## How it Works

1. **Cache**: Issues are cached locally in SQLite (`.lb/cache.db`)
2. **Outbox**: Write commands queue mutations locally
3. **Background Sync**: Worker process automatically pushes to Linear
4. **JSONL Export**: After sync, exports to `.lb/issues.jsonl` (git-friendly)
5. **Scoping**: All issues are filtered by `repo:<name>` label

### JSONL Export

- Linear is the **source of truth**
- `.lb/issues.jsonl` is a **read-only snapshot** (auto-generated)
- Updated after every sync (manual or background)
- Git-trackable: See issue changes in diffs
- bd-compatible format: One JSON object per line

### Background Sync Details

When you create, update, or close an issue:
1. Change is queued in local outbox (instant return)
2. Background worker spawns if not already running
3. Worker processes queue and pushes to Linear
4. Worker exits when queue is empty
5. Next change spawns new worker (smart - only one per repo at a time)

No manual sync needed! Use `--sync` flag only if you need immediate blocking sync.

## Differences from beads

lb is **inspired by** beads but uses Linear as the backend:

| Feature | beads (bd) | lb |
|---------|------------|-----|
| Storage | Local JSONL files | Linear API + SQLite cache |
| Sync | Daemon process | Background worker (spawned on-demand) |
| Issue IDs | `bd-xxx` | `TEAM-123` (Linear format) |
| Offline | Fully offline | Requires network for writes |
| Teams | Single workspace | Multi-team support (auto-detected) |
| JSON format | snake_case, arrays | Same style (bd-inspired) |
| Workflow | Same | Same (ready, create, update, close) |

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
