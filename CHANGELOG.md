# Changelog

## v9

- **Claude Code support**: `lb onboard` now tells agents to use CLAUDE.md (Claude Code) or AGENTS.md (other tools)

## v8

- **Local-only mode**: Run `lb` entirely without Linear by setting `local_only: true` in config. Creates LOCAL-001, LOCAL-002, etc. IDs
- **Offline mode**: Graceful handling when network is unavailable - reads work from cache, writes queue in outbox

## v7

- **Outbox reliability fixes**: Self-healing outbox with stale item detection, synchronous processing for guaranteed delivery
- **Subtask status propagation**: Closing all subtasks of a parent now propagates status to parent
- **Background worker improvements**: PID file touch signaling, 5s idle timeout polling

## v6

- **`lb dep` subcommand**: Manage dependencies with `lb dep add`, `lb dep remove`, `lb dep tree`
- **`lb blocked` command**: Show issues waiting on blockers with reasons
- **`lb delete` command**: Delete issues with background sync support
- **Explicit dependency flags**: `--blocks`, `--blocked-by`, `--related`, `--discovered-from` on create
- **Better relationship display**: `lb show` displays bidirectional relationships, `lb list` shows parent ID for subtasks
- **Improved `lb ready` output**: Count, numbering, and parent context

## v5

- **`lb export` command**: Beads-compatible JSONL export for interop
- **Background JSONL export**: Debounced auto-export to `.lb/issues.jsonl`
- **Cleaner CLI help**: Grouped subcommands by purpose, hidden `[options]` noise

## v4

### Features

- **`lb update --parent` and `--deps`**: Set parent issues and relations (`blocks`, `related`) via update command, not just create
- **Text priority names**: Use `urgent`, `high`, `medium`, `low`, `backlog` instead of numbers 0-4
- **Recursive blocking in `lb ready`**: Children of blocked issues are now also blocked - if parent is blocked, its subtasks won't show in ready
- **Optional issue types**: Issue type labels (`-t bug/feature/task/epic/chore`) are now opt-in via `use_issue_types: true` in config. Off by default since most teams don't use them
- **JSONC config files**: Config now loads from `~/.config/lb/config.jsonc` (global) and `.lb/config.jsonc` (repo). Supports comments. Falls back to `.json` for backwards compatibility
- **`lb migrate remove-type-labels`**: New command to strip old type labels from issues when disabling type system

### Fixes

- **Blocking detection fixed**: Now fetches `inverseRelations` from Linear so issues blocked by others are correctly detected
- **Stale issue cleanup**: Clears issues cache before sync to remove issues that no longer have the repo label
- **Stale dependency cleanup**: Clears deps for an issue before re-caching on `--sync` to remove outdated relations
- **Better input validation**: Deps format validated with clear errors ("Expected 'type:ID'"), invalid status/priority/type values rejected with suggestions

### Improvements

- **Cleaner output**: Removed noisy "queued - background sync started" messages from create/update/close
- **Onboard rewrite**: `lb onboard` now outputs content for AGENTS.md instead of generic instructions. Tells agents to use `lb create` for subtasks, not built-in todo tools

## v3

- **Fast sync**: Parallelized relation fetching (25s -> 3.7s), removed O(n) fetchRelations from bulk sync (27s -> 0.75s)
- **Dependency tracking**: `--deps` flag on create, relations cached and preserved across syncs
- **Background worker fixes**: Reliable spawning with --worker flag and process.execPath
- **Import improvements**: Preserves closed status and parent-child relationships from beads

## v2

- **Install fix**: Fixed bin path for `bun install -g`
- **README rewrite**: Focused on human setup, agent takes over from `lb onboard`

## v1

Initial release.

- Linear-backed issue tracking with local SQLite cache
- Background sync with outbox queue
- `lb auth`, `lb init`, `lb sync` for setup
- `lb create`, `lb update`, `lb close`, `lb list`, `lb show`, `lb ready` for issue management
- `lb import` for beads JSONL migration
- `lb onboard` for agent self-configuration
- Auto-assign issues to current user
- Auto-detect Linear team from repo
