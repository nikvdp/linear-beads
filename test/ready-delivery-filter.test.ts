import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const DATABASE_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "database.ts");
const REMOTE_SYNC_STATE_PATH = join(import.meta.dir, "..", "src", "utils", "remote-sync-state.ts");
const REFS_PATH = join(import.meta.dir, "..", "src", "utils", "merged-bead-refs.ts");

const tempDirs: string[] = [];
setDefaultTimeout(20000);

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeFixtureGh(mode: "ok" | "fail"): string {
  const binDir = mkdtempSync(join(tmpdir(), "lb-gh-fixture-"));
  tempDirs.push(binDir);
  const ghPath = join(binDir, "gh");
  const script =
    mode === "ok"
      ? `#!/bin/bash
# fixture: merged PRs — one delivered bead, one not
echo '[{"number":101,"body":"Delivers the thing.\\n\\nPart of MG-9999"},{"number":102,"body":"closes MG-8888"}]'
`
      : `#!/bin/bash
echo "gh: fixture outage" >&2
exit 3
`;
  writeFileSync(ghPath, script, { mode: 0o755 });
  return binDir;
}

function createRepo(): { repoDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-ready-delivery-"));
  tempDirs.push(repoDir);
  const git = Bun.spawnSync(["git", "init", "-q"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (git.exitCode !== 0) throw new Error("git init failed");
  Bun.spawnSync(
    ["git", "remote", "add", "origin", "https://github.com/metrograph-ai/city-data-explorer.git"],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  mkdirSync(join(repoDir, ".lb"), { recursive: true });
  writeFileSync(join(repoDir, ".lb", "config.jsonc"), "{}\n");
  return { repoDir };
}

const SEED_SETUP = `
  import {
    cacheIssue,
    generateLocalId,
    setIssueIdMapping,
  } from ${JSON.stringify(DATABASE_UTILS_PATH)};
  const now = new Date().toISOString();
  const mk = (title, status) => {
    const id = generateLocalId();
    cacheIssue({ id, title, status, priority: 2, sync_status: "pending", created_at: now, updated_at: now });
    return id;
  };
  const delivered = mk("bead-that-was-delivered", "open");
  const fresh = mk("bead-still-truly-open", "open");
  setIssueIdMapping(delivered, "MG-9999");
  setIssueIdMapping(fresh, "MG-1111");
`;

async function runReadyJson(
  repoDir: string,
  ghMode: "ok" | "fail"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const ghBin = makeFixtureGh(ghMode);
  const script = `
    import { clearRemoteSyncPause, recordRemoteSyncPause } from ${JSON.stringify(REMOTE_SYNC_STATE_PATH)};
    clearRemoteSyncPause();
    // Hermetic lever: an ACTIVE network remote-sync-pause makes ready skip
    // ensureFresh + getViewer (cache-only) while the MG-1207 filter still
    // runs — no Linear sync can wipe the seeded fixtures.
    recordRemoteSyncPause(new Error("fetch failed (fixture offline, MG-1207 test)"));
    ${SEED_SETUP}
    process.argv = ["bun", "ready", "--json"];
    await import(${JSON.stringify(CLI_PATH)});
  `;
  const proc = Bun.spawn(["bun", "--eval", script], {
    cwd: repoDir,
    env: {
      ...process.env,
      PATH: `${ghBin}:${process.env.PATH || ""}`,
      LB_TEAM_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("merged bead refs extraction (MG-1207)", () => {
  test("matches Part of / Closes (any case); ignores Fixes/Related prose", async () => {
    const { extractBeadRefs } = await import(REFS_PATH);
    const refs = extractBeadRefs([
      "Delivers it.\n\nPart of MG-1207",
      "closes mg-8888",
      "Related: MG-55",
      "Fixes MG-77",
      "Part of MG-1207 again repeats",
      "",
    ]);
    expect(refs.has("MG-1207")).toBe(true);
    expect(refs.has("MG-8888")).toBe(true);
    expect(refs.has("MG-55")).toBe(false);
    expect(refs.has("MG-77")).toBe(false);
    expect(refs.size).toBe(2);
  });

  test("getOriginRepo parses https origin remote; null without remote", async () => {
    const { getOriginRepo } = await import(REFS_PATH);
    const { repoDir } = createRepo();
    expect(getOriginRepo(repoDir)).toBe("metrograph-ai/city-data-explorer");
    const bare = mkdtempSync(join(tmpdir(), "lb-noremote-"));
    tempDirs.push(bare);
    Bun.spawnSync(["git", "init", "-q"], { cwd: bare, stdout: "pipe", stderr: "pipe" });
    expect(getOriginRepo(bare)).toBeNull();
  });
});

describe("lb ready delivery filter (MG-1207)", () => {
  test("hides delivered-open beads when merged PRs are visible", async () => {
    const { repoDir } = createRepo();
    const result = await runReadyJson(repoDir, "ok");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("hidden from ready");
    expect(result.stderr).toContain("MG-1207");
    const issues = JSON.parse(result.stdout) as Array<{ title: string }>;
    const titles = issues.map((i) => i.title);
    expect(titles).toContain("bead-still-truly-open");
    expect(titles).not.toContain("bead-that-was-delivered");
  });

  test("gh failure warns loud and serves unfiltered (never silent)", async () => {
    const { repoDir } = createRepo();
    const result = await runReadyJson(repoDir, "fail");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("delivery-filter unavailable");
    expect(result.stderr).toContain("UNFILTERED");
    expect(result.stderr).toContain("MG-1207");
    const issues = JSON.parse(result.stdout) as Array<{ title: string }>;
    const titles = issues.map((i) => i.title);
    expect(titles).toContain("bead-still-truly-open");
    expect(titles).toContain("bead-that-was-delivered");
  });
});
