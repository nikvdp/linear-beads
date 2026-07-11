---
name: lb-auto-mode
description: Claim and complete agent-ready lb tickets through auto mode. Use when running lb auto, polling for work, handling a claimed auto ticket, or following the detached-worktree completion contract.
---

# LB Auto Mode

Use this skill to pull or complete work that has been deliberately marked agent-ready. An `auto` label is a promise that the ticket meets the `lb-execution-loop` quality bar: it is handoff-complete with Why, What, Where, implementation notes, and validation.

## Pull work

Run:

```bash
lb auto next --wait
```

If you were given a worker name, include it every time:

```bash
lb auto next --wait --worker <your-name>
```

Read the JSON status literally:

- `{"status":"no_work"}` is successful. Invoke the same command again to continue polling.
- `{"status":"claimed"}` means the ticket is yours. It is already in progress, assigned in Linear, and has a claim comment.

Do not build a separate shell polling loop. Re-invoke after each `no_work` response so the agent harness retains control.

## Respect worker targeting

`auto:<name>` labels route tickets to one named worker.

- With `--worker <name>` or `LB_WORKER`, poll only `auto:<name>` work and never generic work.
- Without a worker identity, poll only the generic `auto` queue and never targeted work.
- Run `lb worker whoami` to inspect the resolved identity and watched label.

The bare `auto` label is optional on targeted tickets. Any `auto:*` label removes a ticket from the generic pool.

## Start in the worktree

Use the `workdir` returned in the claim payload or supplied in the prompt. It is `.worktrees/<run-id>` on a detached HEAD and is already excluded through `.git/info/exclude`.

Your first action in that directory must create a descriptive branch:

```bash
git checkout -b <your-choice>
```

Never commit on detached HEAD. Never delete the worktree; it holds the branch for review. `lb` commands work normally there because lb resolves the main repository's shared `.lb/` directory.

## Complete or release the ticket

Implement only the claimed ticket scope and commit each logical concern atomically. When complete:

```bash
lb close <id> --reason "Brief summary of completed work"
```

If genuinely blocked:

1. Add the concrete findings with `lb comment add <id> "..."`.
2. Release the claim with `lb update <id> --status open`.
3. Stop work.

Never leave a claimed ticket silently abandoned. The runner observes process exit but does not close, retry, or release tickets for you.

## Author auto-ready tickets

Apply `auto` only to executable children, never to parents or epics. Make every labeled child self-contained enough that an agent can execute it without waiting for a human answer. Use `auto:<worker>` when the work must target a named worker.
