# linear-beads (lb)

Linear-backed issue tracking for AI agents. Inspired by [beads](https://github.com/steveyegge/beads).

`lb` gives you beads-style issue tracking with Linear as the backend. Your issues live in Linear where you can see them, but agents interact through a fast CLI with JSON output, background sync, and dependency tracking. Backward-compatible interop (import/export) with [beads](https://github.com/steveyegge/beads) issues.jsonl.

## Quickstart

Tell your agent:

> Run `lb onboard`

That's it. The agent will walk you through setup (install, auth, etc.) and configure itself to use `lb` for task tracking.

## Install

**Download a binary** from [releases](https://github.com/nikvdp/linear-beads/releases) and add it to your PATH.

**Or with bun:**
```bash
bun install -g github:nikvdp/linear-beads
```

## What happens behind the scenes

When your agent runs `lb onboard`, it will:

1. **Install lb** if not already installed
2. **Authenticate with Linear** (`lb auth`) - you'll be prompted for your API key
3. **Initialize the project** (`lb init`) - creates `.lb/` directory and syncs with Linear
4. **Update its instruction file** (CLAUDE.md or AGENTS.md) with lb usage instructions

After onboarding, your agent uses `lb` instead of its built-in task tools. Issues sync to Linear so you can see them in the Linear UI.

## Repo Scoping (Label vs Project)

By default, `lb` uses Linear labels to scope issues to a repository (e.g., `repo:my-project`). You can also use Linear Projects for scoping, or both.

### Configuration

Add to `.lb/config.jsonc`:

```jsonc
{
  "repo_scope": "label"  // "label" (default), "project", or "both"
}
```

| Mode | Description |
|------|-------------|
| `label` | Uses `repo:name` labels (default, backward compatible) |
| `project` | Uses Linear Projects - one project per repo |
| `both` | Uses both labels and projects |

### Migrating from Labels to Projects

If you have existing label-scoped issues and want to switch to project scoping:

```bash
# Preview what would change
lb migrate to-project --dry-run

# Migrate issues to project (keeps labels)
lb migrate to-project

# Migrate and remove the repo label
lb migrate to-project --remove-label
```

## Offline & Local-Only Modes

`lb` works offline and can run entirely without Linear.

### Offline Mode

When you lose internet connectivity, `lb` continues working:
- All reads work from local SQLite cache
- Writes queue in an outbox and sync when you're back online
- `lb sync` shows a friendly message instead of failing

### Local-Only Mode

For pure local usage (no Linear backend), add to `.lb/config.jsonc`:

```jsonc
{
  "local_only": true
}
```

In local-only mode:
- `lb sync` is disabled (shows a message)
- `lb create` generates LOCAL-001, LOCAL-002, etc. IDs
- All commands work from local SQLite only
- Great for AI-only workflows or trying out lb without Linear

## License

MIT
