# linear-beads (lb)

[Linear](https://linear.app/)-backed issue tracking for AI agents. Inspired by [beads](https://github.com/steveyegge/beads).

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

`lb` supports three scoping modes:
- `label`: scope by `repo:<name>` label
- `project`: scope by Linear project name
- `both`: include both scopes

For backward compatibility, the runtime fallback remains `label` when no repo config exists.  
For new repos, first-time `lb init` writes `.lb/config.jsonc` with `repo_scope: "project"` and the detected `repo_name`.

### Configuration

Add to `.lb/config.jsonc`:

```jsonc
{
  "repo_scope": "project"  // "label", "project", or "both"
}
```

| Mode | Description |
|------|-------------|
| `label` | Uses `repo:name` labels (backward-compatible fallback) |
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

## Agent Mail (Local + Linear)

`lb` supports agent identity and mailbox commands with local-first persistence:

- `lb agent register --handle <name>`
- `lb agent whoami`
- `lb agent list`
- `lb mail send --from <handle> --to <handle[,handle]> --subject <s> --body <md>`
- `lb mail inbox --agent <handle> [--unread]`
- `lb mail read --agent <handle> --message <id>`
- `lb mail ack --agent <handle> --message <id>`
- `lb mail reply --agent <handle> --message <id> --body <md>`
- `lb mail thread --thread <id>`

### Mail backend config

Add to `.lb/config.jsonc`:

```jsonc
{
  "mail_backend": "local", // or "linear"
  "issue_backend": "linear"
}
```

- `mail_backend: "local"` keeps mail fully local in SQLite.
- `mail_backend: "linear"` projects local mail operations to Linear comments and polls Linear comments back into local inbox.
- `local_only: true` always forces local behavior, regardless of backend settings.

### Adapter contract (mail)

Mail backends implement a stable adapter contract so future backends do not require command rewrites:

- `send(messageId)` / `reply(messageId)` for outbound projection
- `markRead(messageId, recipientAgentId)` / `ack(messageId, recipientAgentId)` for receipt projection
- `ingest({limit})` for pull-based inbox updates + cursor checkpointing

`lb` remains local-first: writes always hit local SQLite first, then outbox/worker projection runs second.

### Validation matrix

The following phase-2 checks were run:

1. Local-only mode regression:
   - existing issue command tests pass
   - local mail flow (`send/read/reply/ack/thread`) passes
2. Linear mode projection:
   - local mail send with `--work-item linear:<ISSUE-ID>` creates an envelope comment in Linear
3. Linear mode ingest:
   - remote envelope comment is pulled on `lb sync` and appears in local inbox
4. Sync/issue regression:
   - existing sync and issue integration tests still pass (known flaky sync test remains intermittently flaky and passes on immediate isolated rerun)

### Smoke runbook (compiled binary)

Use this from a repo that has `.lb/config.jsonc` and Linear auth configured:

```bash
lb agent register --handle Alpha
lb agent register --handle Beta

lb create "Mail smoke issue" --sync --json
# then use returned issue id in --work-item linear:<ID>

lb mail send --from Alpha --to Beta --subject "Smoke" --body "Hello" --work-item linear:LIN-123 --json
lb sync --json
lb mail inbox --agent Beta --json
```

### Smoke runbook (in-repo dev CLI)

Use this exact sequence from the repo root to validate local mail behavior with the development CLI:

```bash
bun run src/cli.ts agent register --handle Alpha
bun run src/cli.ts agent register --handle Beta

bun run src/cli.ts mail send \
  --from Alpha \
  --to Beta \
  --subject "Smoke thread" \
  --body "Hello from Alpha" \
  --json

MID=$(bun run src/cli.ts mail inbox --agent Beta --unread --json | jq -r '.[0].message.id')
bun run src/cli.ts mail read --agent Beta --message "$MID"
bun run src/cli.ts mail reply --agent Beta --message "$MID" --body "Ack from Beta"

RID=$(bun run src/cli.ts mail inbox --agent Alpha --json | jq -r '.[0].message.id')
bun run src/cli.ts mail ack --agent Alpha --message "$RID"

TID=$(bun run src/cli.ts mail inbox --agent Alpha --json | jq -r '.[0].message.thread_id')
bun run src/cli.ts mail thread --thread "$TID" --json
```

For Linear projection/ingest validation, set `mail_backend: "linear"` and include a `--work-item linear:<ISSUE-ID>` when sending.

## License

MIT
