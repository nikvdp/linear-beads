---
name: lb-execution-loop
description: Plan and execute Linear/lb work with a strict claim-code-commit-close loop. Use when splitting work into parent/children with blockers and shipping each child in order.
---

# LB Execution Loop

## Setup

1. Create or identify one parent issue.
2. Create child issues for each implementation unit.
3. Encode sequence with blocker links.

## Execution contract

For each child issue, in order:

1. Claim: `lb update <id> --status in_progress`
2. Code: implement only that issue scope
3. Commit: atomic commits for completed logical changes
4. Close: `lb close <id> --reason "..."`

## Ticket quality bar

Each issue should include:

- Why: problem and user impact
- What: exact behavior change and non-goals
- Where: concrete file paths
- How: implementation approach
- Validation: checks to run and success criteria

## Notes

- Do not batch status changes at end of day.
- Keep dependencies explicit in lb, not only in prose.
- Keep changes scoped to the claimed issue.
- When a flag can take long text, prefer writing a temp file and passing `@file` instead of inline shell strings.
- When editing long descriptions during execution, prefer `lb show <id> --body` plus paired `lb update <id> --replace ... --with ...` over copying full bodies through the model.
- `lb` is Nik's personal tracking tool. Never include `lb` ticket IDs in commit messages, docs, PRs, release notes, or other user-facing or team-facing artifacts.
