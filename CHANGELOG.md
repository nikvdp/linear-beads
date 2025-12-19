# Changelog

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

Initial public release.
