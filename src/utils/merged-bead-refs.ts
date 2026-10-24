/**
 * merged-bead-refs.ts — delivery evidence for bead IDs (MG-1207).
 *
 * A merged PR whose body carries "Part of MG-x" / "Closes MG-x" (the
 * fleet's documented PR-body convention, rule 30) marks that bead as
 * DELIVERED-but-not-yet-closed: rule 15 keeps it open through the
 * staging window, and `lb ready` (which serves status=open) was
 * therefore serving already-delivered beads — 9 of 13 spot-audited
 * candidates on 2026-08-25, three burned dispatch cycles, duplicate
 * claim risk across instances (beryl's report = this bead).
 *
 * One `gh pr list` call per invocation builds the ref set; both
 * `lb ready` and the auto-claimable pool filter against it (rule 24:
 * one implementation, two call sites — auto-claims were the same class
 * waiting to happen).
 *
 * Failure semantics (fail-honest, never silently stale): when the query
 * fails, callers receive the error and must say so while serving
 * unfiltered — a loud "may be stale" beats both a hard failure (ready is
 * an advisory listing) and a silent fallthrough (the original defect).
 */

import { spawnSync } from "child_process";

const BEAD_REF_RE = /\b(?:Part of|Closes)\s+(MG-\d+)\b/gi;

/** Extract canonical bead IDs (uppercase MG-###) from merged-PR bodies. */
export function extractBeadRefs(bodies: string[]): Set<string> {
  const refs = new Set<string>();
  for (const body of bodies) {
    if (!body) continue;
    for (const match of body.matchAll(BEAD_REF_RE)) {
      refs.add(match[1].toUpperCase());
    }
  }
  return refs;
}

/** owner/repo from the current directory's origin remote, or null. */
export function getOriginRepo(cwd?: string): string | null {
  const res = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (res.status !== 0 || !res.stdout) return null;
  const url = res.stdout.trim();
  const https = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return https ? https[1] : null;
}

export interface MergedBeadRefs {
  refs: Set<string>;
  error: string | null;
}

/**
 * Fetch merged PRs for *repo* (default: origin remote) and return the
 * delivery-marked bead IDs. `gh` uses GH_TOKEN/GITHUB_TOKEN or its own
 * auth; nothing here logs or prints secrets.
 */
export function fetchMergedBeadRefs(repo?: string | null, cwd?: string): MergedBeadRefs {
  const target = repo ?? getOriginRepo(cwd);
  if (!target) {
    return { refs: new Set(), error: "origin remote unavailable" };
  }
  const res = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      target,
      "--state",
      "merged",
      "--limit",
      "300",
      "--json",
      "number,body",
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
    }
  );
  if (res.status !== 0) {
    const err = (res.stderr || "").trim().split("\n")[0] || `gh exited ${res.status}`;
    return { refs: new Set(), error: err.slice(0, 200) };
  }
  try {
    const prs = JSON.parse(res.stdout) as Array<{ number: number; body?: string }>;
    return { refs: extractBeadRefs(prs.map((p) => p.body || "")), error: null };
  } catch {
    return { refs: new Set(), error: "unparseable gh pr list output" };
  }
}
