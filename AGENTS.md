# lb-cli

This repo uses **lb** for all planning and task tracking.

## CRITICAL: Task Tracking with `lb`

**DO NOT use the TodoWrite/TodoRead tools. NEVER. Use `lb` instead.**

### Before Starting ANY Work

```bash
lb sync                    # Pull latest from Linear
lb ready                   # See unblocked work
lb show LIN-XXX            # Read full description before starting
lb update LIN-XXX --status in_progress   # Claim it
```

### Planning Work

When you need to break down a task into steps, **create subtasks in lb**, not mental notes or TodoWrite:

```bash
lb create "Step 1: Do X" --parent LIN-XXX -d "Details..."
lb create "Step 2: Do Y" --parent LIN-XXX -d "Details..."
```

### During Work

```bash
# Found something that needs doing? Create an issue
lb create "Found: need to fix X" --parent LIN-XXX -d "Context..."

# Discovered a blocker or dependency?
lb update LIN-AAA --deps blocks:LIN-BBB   # AAA blocks BBB
```

### Completing Work

```bash
lb close LIN-XXX --reason "Brief summary of what was done"
```

### Key Commands Reference

| Command                                       | Purpose                               |
| --------------------------------------------- | ------------------------------------- |
| `lb sync`                                     | Sync with Linear                      |
| `lb ready`                                    | Show unblocked issues you can work on |
| `lb list`                                     | Show all issues                       |
| `lb show LIN-XXX`                             | Full issue details                    |
| `lb update LIN-XXX --status in_progress`      | Claim work                            |
| `lb close LIN-XXX --reason "why"`             | Complete work                         |
| `lb create "Title" --parent LIN-XXX -d "..."` | Create subtask                        |

### Rules

1. **NEVER use TodoWrite** - use `lb create` for subtasks instead
2. **Always `lb sync` and `lb ready`** before asking what to work on
3. **Always `lb show`** to read the full description before starting
4. **Always `lb update --status in_progress`** before starting work
5. **Always include descriptions** with context for handoff
6. **Close issues with reasons** explaining what was done

## Git Workflow

Commit atomically as you work (one logical change per commit) unless told otherwise.

## Architecture Principles

- `lb` is local-first. Keep local behavior, local state, and local identity coherent even when sync is delayed or unavailable.
- Sync adapters are pluggable. Linear is the current adapter, not the architectural center of the app.
- Internal issue identity must remain stable across the full lifecycle from local creation through remote reconciliation. Do not treat surface `LOCAL-*` names as the canonical identity.
- `LOCAL-*` identifiers are temporary user-facing aliases. They are useful at the CLI boundary, but internal logic should prefer the stable lb-side canonical identity and sync-key-based resolution.
- Adapter and codec layers that write outward should opportunistically prefer resolved `LIN-*` identifiers whenever resolution is known.
- If stale unresolved local references make it into stored content, later reads or writes should heal them toward resolved `LIN-*` references whenever enough information is available.
- Keep the layers distinct:
  - local model and canonical identity
  - resolution and healing
  - outbound sync adapter / codec
  - inbound render / CLI presentation
- User-facing output should stay simple and literal where possible, even if adapter storage uses richer remote representations.
- Linear description round-trip rules:
  - The Linear UI should receive true issue mentions, not authored markdown links.
  - The safe authoring form is an angle-wrapped Linear issue URL such as `<https://linear.app/<workspace>/issue/LIN-123>`.
  - Linear API readback may normalize valid mentions into markdown-link-looking `description` text; treat that as stable readback, not as a signal to rewrite again.
  - Rewrite canonical issue refs inside inline backticks; keep fenced code blocks literal.
  - Raw URL plus trailing punctuation like `https://.../LIN-123:` is invalid for this path and must be healed into a safe mention form with punctuation outside the URL.
- Linear media round-trip rules:
  - The local canonical DSL is markdown-like and explicit, using `lb-media:<id>` targets.
  - Images use `![label](lb-media:m_abc123)` and generic files use `[label](lb-media:m_def456)`.
  - Local file paths are supplied by CLI flags, not stored inline in the canonical description text.
  - When writing to Linear, uploaded `uploads.linear.app` assets should be embedded via normal markdown syntax:
    - markdown image syntax becomes a native `image` node in Linear document content
    - markdown link syntax to an uploaded asset becomes a native `file` node in Linear document content
  - Linear issue attachments are a separate native surface from description-embedded media; do not assume one automatically creates the other.
  - `uploads.linear.app` asset downloads are private; retrieval commands must send the Linear auth header instead of assuming the asset URL is public.
  - `lb show` should render canonical `lb-media:<id>` markers, never raw Linear upload URLs.
