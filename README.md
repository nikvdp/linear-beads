# linear-beads (lb)

Linear-backed issue tracking for AI agents. Inspired by [beads](https://github.com/steveyegge/beads).

`lb` gives you beads-style issue tracking with Linear as the backend. Your issues live in Linear where you can see them, but agents interact through a fast CLI with JSON output, background sync, and dependency tracking. Backward-compatible interop (import/export) with [beads](https://github.com/steveyegge/beads) issues.jsonl.

## Install

**Download a binary** from [releases](https://github.com/nikvdp/linear-beads/releases) and add it to your PATH.

**Or with bun:**
```bash
bun install -g github:nikvdp/linear-beads
```

## Setup

```bash
# Authenticate with Linear (get your API key at https://linear.app/settings/api)
lb auth

# In your project
cd your-project
lb init
```

## Tell your agent

Add this to your project's AGENTS.md or CLAUDE.md:

```
This project uses lb for issue tracking. Run `lb onboard` and follow the instructions.
```

Your agent will run `lb onboard`, which outputs everything it needs to set up AGENTS.md and start tracking work.

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
