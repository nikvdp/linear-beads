---
name: lb-basic-usage
description: Use lb as the primary task tracker in Linear-backed repos. Use when claiming work, creating dependencies/subissues, updating status, closing work, or avoiding ephemeral built-in todo tools.
---

# lb Basic Usage

Use `lb` as the source of truth for task tracking in this repo.

## Core loop

1. Run `lb sync`.
2. Run `lb ready`.
3. Open the ticket with `lb show <id>`.
4. Claim it with `lb update <id> --status in_progress`.
5. Do the work.
6. Close with `lb close <id> --reason "..."`.

## Dependencies and decomposition

- Create dependent work with `--blocks` and `--blocked-by`.
- Create subissues with `--parent`.
- Link discovered work with `--discovered-from`.
- Use `lb dep tree <id>` to verify order.

## Multiline descriptions

Avoid literal escaped `\n` in issue descriptions.
For long text, prefer temp files plus `@file`, for example `lb create "Title" -d @body.md` or `lb update <id> -d @body.md`.
`--description-file` and `--description-stdin` also work when they fit better.
`lb` auto-heals likely accidental `\n` sequences by default and warns loudly.
Use `--no-auto-format-escaped-newlines` only when you intentionally need literal `\n` stored.

Use the same pattern for other long body-like flags:
- `lb close <id> --reason @reason.md`

## Editing long ticket bodies

- Use `lb show <id> --body` to fetch only the normalized body text.
- Use `lb update <id> --replace "old" --with "new"` for small exact edits.
- Use `lb update <id> --replace @old.md --with @new.md` for large chunks.
- Each `--replace` must pair with the next `--with`.
- `lb` still rewrites and queues the full updated body, but this saves agent tokens and keeps edits aligned with the shown text surface.

## Visibility rules

- `lb` is Nik's personal tracking tool, not a team-facing system.
- Never include `lb` ticket IDs in commit messages, documentation, PR text, release notes, user-facing copy, or other team-facing artifacts.
- Summarize work in plain language when writing for humans outside your own `lb` workflow.

## Useful commands

`lb list`, `lb ready`, `lb blocked`, `lb show <id>`, `lb create`, `lb update`, `lb close`, `lb dep add`.
