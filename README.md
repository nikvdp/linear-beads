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

## Editing bundled onboarding and skills

The packaged onboarding text and installable skills are authored as normal repo files under `src/content/`:

- `src/content/onboard/` holds the long, short, and wrapper markdown used by `lb onboard`
- `src/content/skills/` holds each packaged skill's `SKILL.md` and `agents/openai.yaml`

The CLI still bundles those files into the app at build time, but the source of truth for editing is now the markdown and yaml on disk rather than large TypeScript string literals.

## Repo Scoping (Label vs Project)

`lb` supports three scoping modes:

- `label`: scope by `repo:<name>` label
- `project`: scope by Linear project name
- `both`: include both scopes

Scope resolution is versioned:

- If `repo_scope` is explicitly set, that value is used.
- Otherwise `repo_binding_version` controls the implicit default:
  - `1` => `label` (legacy default)
  - `2` => `project` (new default)

For new repos, first-time `lb init` writes `.lb/config.jsonc` with detected `repo_name` and `repo_binding_version: 2`.
Legacy repos without config are inferred as `repo_binding_version: 1` to preserve label-default behavior.

### Configuration

Add to `.lb/config.jsonc`:

```jsonc
{
  "repo_scope": "project", // optional explicit mode: "label", "project", or "both"
  "repo_binding_version": 2, // implicit default policy when repo_scope is omitted (1 or 2)
}
```

| Mode      | Description                                            |
| --------- | ------------------------------------------------------ |
| `label`   | Uses `repo:name` labels (backward-compatible fallback) |
| `project` | Uses Linear Projects - one project per repo            |
| `both`    | Uses both labels and projects                          |

### Temporary One-Off Scope Overrides

For one-off non-repo task work, you can override scope at runtime without writing config files.

```bash
# One-off scope for a single command
lb --temp-name oneoff-planning --temp-name-mode label list

# Environment-based overrides for a shell session
export LB_TEMP_NAME=oneoff-planning
export LB_TEMP_NAME_MODE=project
lb create "Plan migration" --sync
```

Precedence is: CLI temp flags > env temp vars > config > git heuristic.

### Migrating from Labels to Projects

If you have existing label-scoped issues and want to switch to project scoping:

```bash
# Preview what would change
lb migrate to-project --dry-run

# Migrate issues to project (default: move, removes old repo label)
lb migrate to-project

# Keep the old repo label (copy behavior)
lb migrate to-project --keep-label
```

`migrate to-project` always sources issues by `repo:<repo_name>` label and paginates through all matches.

### Rebinding Repo Name/Scope

When renaming a repo or changing scope mode, use `lb rebind`.
By default, source matching uses `both` scope so rebinding still works after partial migrations (for example project-only issues in a label-configured repo).

```bash
# Preview move from current binding to new name (same scope)
lb rebind --to-name new-repo-name --dry-run

# Move binding from current tuple to target project scope
lb rebind --to-name new-repo-name --to-scope project

# Move from label-only source to project-only target explicitly
lb rebind --from-scope label --to-name new-repo-name --to-scope project

# Move from project-only source to label-only target explicitly
lb rebind --from-scope project --to-name legacy-repo-name --to-scope label

# Rare opt-out: update local config only, do not migrate issues
lb rebind --to-name new-repo-name --to-scope project --config-only
```

### Repo Binding Smoke Test

Run this end-to-end smoke script to validate init defaults plus migrate/rebind behavior against Linear:

```bash
bun run scripts/smoke-repo-binding.ts
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
  "local_only": true,
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

Mail handles only become cross-client discoverable when the Linear mail backend is paired with a shared registry issue.

### Mail backend config

Add to `.lb/config.jsonc`:

```jsonc
{
  "mail_backend": "local", // or "linear"
  "issue_backend": "linear",
  "mail_registry_work_item": "linear:LIN-123" // required for shared cross-client lookup
}
```

- `mail_backend: "local"` keeps mail fully local in SQLite.
- `mail_backend: "linear"` projects local mail operations to Linear comments and polls Linear comments back into local inbox.
- `mail_registry_work_item` is optional for repo-local mail, but required for shared cross-client handle discovery.
- `local_only: true` always forces local behavior, regardless of backend settings.

### Identity and address resolution

Without `mail_registry_work_item`:

- `lb agent register --handle Alpha` keeps `Alpha` as a local handle when available.
- `lb agent list` shows the local cache only.
- `lb mail send --to Beta` only works if `Beta` already exists in the same local cache.

With `mail_backend: "linear"` and `mail_registry_work_item` configured:

- `lb agent register --handle Alpha` returns the final allocated handle, which may be `Alpha-ab12` instead of plain `Alpha`.
- `lb agent list` refreshes the shared directory before listing cached identities.
- `lb mail send --to Alpha-ab12` can resolve unknown local handles through the shared directory.

Use the final registered handle in scripts, prompts, and handoffs. Do not assume the unsuffixed requested base is globally unique.

### Safe failure modes

- If the shared directory is not configured, cross-client lookup fails with an explicit `mail_registry_work_item` hint.
- If the shared directory is unavailable, local mail state still persists and remote projection can retry later.
- `local_only: true` never pretends repo-local handles are globally discoverable.

### Adapter contract (mail)

Mail backends implement a stable adapter contract so future backends do not require command rewrites:

- `send(messageId)` / `reply(messageId)` for outbound projection
- `markRead(messageId, recipientAgentId)` / `ack(messageId, recipientAgentId)` for receipt projection
- `ingest({limit})` for pull-based inbox updates + cursor checkpointing

`lb` remains local-first: writes always hit local SQLite first, then outbox/worker projection runs second.

### Remote ID waiting

Normal `lb` workflows should keep using local ids and let background sync reconcile them later.
You usually do not need to wait for a remote `LIN-*` id just to build parent, blocker, or related graphs.

Use `--wait` only when a script truly needs a resolved remote id immediately:

```bash
lb create "Needs remote id now" --wait --json
lb create "Needs a short wait budget" --wait --wait-timeout-ms 5000 --json
```

Contract:

- success prints the normal issue JSON with a resolved `LIN-*` id
- timeout exits non-zero with structured JSON on stderr, including the preserved local id
- paused or offline waits also exit non-zero with structured JSON on stderr
- local-only repos reject `--wait` because no remote id can ever resolve there

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

lb mail send --from Alpha-ab12 --to Beta-cd34 --subject "Smoke" --body "Hello" --work-item linear:LIN-123 --json
lb sync --json
lb mail inbox --agent Beta-cd34 --json
```

In shared-directory mode, use the final handles returned by `lb agent register`, not the raw requested bases.

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
