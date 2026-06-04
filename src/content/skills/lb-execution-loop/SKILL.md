---
name: lb-execution-loop
description: Plan and execute Linear/lb work with a strict claim-code-commit-close loop. Use when splitting work into parent/children with blockers and shipping each child in order.
---

# LB Execution Loop

Use this skill when work needs real decomposition, ordering, and handoff quality. The goal is not only to track work in `lb`, but to write issues that another agent can pick up and execute without re-discovering the plan.

## Default shape

1. Create or identify one parent issue for the user-visible goal.
2. Create child issues for each independently executable implementation unit.
3. Create deeper descendants only when a child still hides multiple real execution steps.
4. Encode execution order with blocker links, not only prose.

Prefer hierarchy over flat lists when the work has clear containment. Prefer encapsulated child issues over one large ticket with a long checklist.

## Planning standard

Before writing implementation tickets, do enough code reading to make the plan real.

- Read the relevant files first.
- Identify likely edit points, symbols, and commands.
- Decide what should be parent scope versus child scope.
- Use blockers to tell consuming agents what can run now and what must wait.

Do not create vague implementation tickets that say only "investigate", "fix", or "wire this up" unless the ticket is explicitly a research task.

## Hierarchy and encapsulation

- Parent issues should describe the overall outcome, constraints, and decomposition.
- Child issues should each map to one shippable unit of work.
- If a child cannot be implemented in one coherent pass, split it again.
- Keep unrelated changes in separate children even if they touch nearby code.
- Use `--parent` so the graph shows containment, not only chronology.

Good child issue boundaries:
- one behavior change
- one migration or schema step
- one command surface
- one UI slice
- one test or validation slice when it is substantial enough to stand alone

## Blockers define order

Use blockers to encode the intended execution plan.

- If child B depends on child A landing first, add the blocker edge.
- If a downstream agent should wait, express that in `lb`, not only in the description.
- If work is parallelizable, leave the siblings unblocked.
- Use `lb dep tree <id>` to verify the graph matches the intended order. For parent
  issues, check the `Children (execution order)` section before claiming work.

The rule is simple: `lb ready` should expose the next sensible execution step without requiring another agent to read your mind.

## Execution contract

For each child issue, in order:

1. Claim: `lb update <id> --status in_progress`
2. Code: implement only that issue scope
3. Commit: atomic commits for completed logical changes
4. Close: `lb close <id> --reason "..."`

## Ticket quality bar

Every actionable issue should be handoff-complete. Another agent should be able to start from the ticket without re-planning the whole change.

## Required structure

Each implementation issue should include:

- Why: problem, user impact, and why this issue exists
- What: exact behavior change
- Non-goals: what this issue is not doing
- Where: specific files, modules, functions, or command surfaces
- Implementation notes: concrete edits to make
- Validation: commands, tests, or observable checks
- Dependencies: parent/child context plus blocker order when relevant

## Detail expectations

Prefer specifics over summaries. Useful ticket details include:

- file paths to inspect or edit
- symbols, functions, classes, or commands involved
- line references when they help the next agent start faster
- example snippets or API shapes
- exact state transitions or data changes
- edge cases, failure modes, or migration notes
- what to leave alone

Bad:
- "Fix onboarding"
- "Refactor the sync flow"
- "Investigate and clean this up"

Better:
- "Update `src/content/onboard/agents-long.md` and `src/content/onboard/agents-short.md` so the planning section explicitly tells agents to create subissues for executable implementation units and use blockers for order. Keep mail and multiline guidance unchanged. Validate with `lb onboard --agents-md --short` and `lb onboard --agents-md`."

## Ticket author responsibility

- The ticket author does the research needed to make the ticket executable.
- Do not push vague planning debt onto the next agent.
- If you do not yet know the edit points, create a research ticket first, then follow with implementation children.
- If you discover new scoped work during implementation, create a new child issue instead of silently expanding the current one.

## Notes

- Do not batch status changes at end of day.
- Keep dependencies explicit in lb, not only in prose.
- Keep changes scoped to the claimed issue.
- When a flag can take long text, prefer writing a temp file and passing `@file` instead of inline shell strings.
- When editing long descriptions during execution, prefer `lb show <id> --body` plus paired `lb update <id> --replace ... --with ...` over copying full bodies through the model.
- `lb` is Nik's personal tracking tool. Never include `lb` ticket IDs in commit messages, docs, PRs, release notes, or other user-facing or team-facing artifacts.
