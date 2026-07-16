# lb Onboard

This repo uses `lb` for Linear-backed issue tracking.

## Use This Output

Add lb guidance to your instruction file:
- **Claude Code**: CLAUDE.md
- **Other tools**: AGENTS.md

Append if the file exists; create if needed.

Raw block for direct append:

```bash
# Full agents.md block (default long)
lb onboard --agents-md >> AGENTS.md

# Explicit short/long variants
lb onboard --agents-md --short >> AGENTS.md
lb onboard --agents-md --long >> AGENTS.md
```

Install packaged skills instead of copy/paste:

```bash
lb skill list
lb skill install lb-basic-usage --codex
lb skill install lb-execution-loop --claude
lb skill install all --pi
```

Persistence options:

- Repo-local: add to `./AGENTS.md` (or `./CLAUDE.md` for Claude).
- User-global: add to a global instruction file.
- Skills: install once to a shared skills directory for reuse.

---

{{AGENTS_MD_BLOCK}}

---

After setup, run `lb sync` then `lb ready` to find work.
