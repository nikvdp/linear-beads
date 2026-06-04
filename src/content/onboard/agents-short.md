## Use `lb` For Task Tracking

Use `lb` as the only task system for this repo. Do not use built-in todo tools.

### Core Loop

```bash
lb sync
lb ready
lb show LIN-XXX
lb update LIN-XXX --status in_progress
# do the work
lb close LIN-XXX --reason "Done"
```

### Split Work Into Subissues

```bash
lb create "Step 1: ..." --parent LIN-XXX
lb create "Step 2: ..." --parent LIN-XXX --blocked-by LIN-YYY
```

Prefer one parent issue for the overall goal and child issues for independently executable implementation units. Use blockers to encode order so another agent can run `lb ready` and see the intended next step. Run `lb dep tree <parent>` and check `Children (execution order)` before claiming child work.

Write implementation tickets with enough detail for handoff:
- exact behavior change and non-goals
- likely files, functions, or commands to edit
- concrete edit notes, not vague summaries
- validation steps

### Dependency Links

```bash
lb create "Must do first" --blocks LIN-123
lb create "Depends on auth" --blocked-by LIN-100
lb create "Found: X" --discovered-from LIN-50 -d "Details..."
lb dep tree LIN-XXX  # Shows children and blocker order
```

### Multiline Descriptions

Do not pass literal `\n` in descriptions. For long text, prefer temp files plus `@file`, for example `lb create "Title" -d @body.md` or `lb update ID -d @body.md`.

### Editing Long Bodies

When changing part of a long ticket body:
- use `lb show LIN-XXX --body` to fetch the normalized body text
- use `lb update LIN-XXX --replace "old" --with "new"` for small edits
- use `lb update LIN-XXX --replace @old.md --with @new.md` for large chunks
- `lb` still queues the full rewritten body, but this avoids wasting model tokens on full-body rewrites

For other long text flags, use the same `@file` pattern:
- `lb close LIN-XXX --reason @reason.md`

### Remote IDs

Default to local-first issue creation and keep using the returned local id for normal graph building.
Use `lb create --wait --json` only when a script truly needs a resolved remote `LIN-*` immediately.

### Keep Guidance Persistent

- Add this section to repo-level `AGENTS.md` or `CLAUDE.md`.
- You can also install packaged lb skills:
  - `lb skill install lb-basic-usage --codex`
  - `lb skill install lb-execution-loop --claude`
