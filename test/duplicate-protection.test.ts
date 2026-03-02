import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createLocalOnlyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lb-dup-protection-"));
  tempDirs.push(dir);

  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (init.exitCode !== 0) {
    throw new Error("failed to init temp git repo");
  }

  mkdirSync(join(dir, ".lb"), { recursive: true });
  writeFileSync(
    join(dir, ".lb", "config.jsonc"),
    `${JSON.stringify({ local_only: true }, null, 2)}\n`
  );

  return dir;
}

async function runLb(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
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

async function runLbJson<T>(cwd: string, ...args: string[]): Promise<T> {
  const result = await runLb(cwd, ...args, "--json");
  if (result.exitCode !== 0) {
    throw new Error(
      `lb ${args.join(" ")} failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`
    );
  }
  return JSON.parse(result.stdout) as T;
}

describe("duplicate protection", () => {
  test("blocks duplicate create by default", async () => {
    const repo = createLocalOnlyRepo();

    const first = await runLb(repo, "create", "Duplicate guard test", "--json");
    expect(first.exitCode).toBe(0);

    const second = await runLb(repo, "create", "Duplicate guard test", "--json");
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("duplicate_detected");
  });

  test("reuses existing issue with --reuse-if-duplicate", async () => {
    const repo = createLocalOnlyRepo();

    const first = await runLbJson<Array<{ id: string }>>(repo, "create", "Reuse duplicate");
    const reused = await runLbJson<Array<{ id: string }>>(
      repo,
      "create",
      "Reuse duplicate",
      "--reuse-if-duplicate"
    );

    expect(reused[0].id).toBe(first[0].id);
  });

  test("allows intentional duplicates with --allow-duplicate", async () => {
    const repo = createLocalOnlyRepo();

    const first = await runLbJson<Array<{ id: string }>>(repo, "create", "Allow duplicate");
    const second = await runLbJson<Array<{ id: string }>>(
      repo,
      "create",
      "Allow duplicate",
      "--allow-duplicate"
    );

    expect(second[0].id).not.toBe(first[0].id);
  });
});

describe("dedupe command", () => {
  test("consolidates duplicates and preserves blocks relationships", async () => {
    const repo = createLocalOnlyRepo();

    const target = await runLbJson<Array<{ id: string }>>(repo, "create", "Dedupe target");
    const a = await runLbJson<Array<{ id: string }>>(repo, "create", "Dedupe source");
    const b = await runLbJson<Array<{ id: string }>>(
      repo,
      "create",
      "Dedupe source",
      "--allow-duplicate"
    );

    const addDep = await runLb(repo, "dep", "add", b[0].id, "--blocks", target[0].id);
    expect(addDep.exitCode).toBe(0);

    const dryRun = await runLbJson<{
      mode: string;
      totals: { clusters: number; duplicate_issues: number };
    }>(repo, "dedupe");
    expect(dryRun.mode).toBe("dry-run");
    expect(dryRun.totals.clusters).toBeGreaterThanOrEqual(1);
    expect(dryRun.totals.duplicate_issues).toBeGreaterThanOrEqual(1);

    const executed = await runLbJson<{
      mode: string;
      duplicate_issues_deleted: number;
    }>(repo, "dedupe", "--execute");
    expect(executed.mode).toBe("execute");
    expect(executed.duplicate_issues_deleted).toBeGreaterThanOrEqual(1);

    const dupesAfter = await runLbJson<Array<{ id: string; title: string }>>(repo, "list", "--all");
    const withTitle = dupesAfter.filter((issue) => issue.title === "Dedupe source");
    expect(withTitle.length).toBe(1);

    const canonical = withTitle[0];
    const showCanonical = await runLbJson<Array<{ id: string; blocks?: string[] }>>(
      repo,
      "show",
      canonical.id
    );
    expect(showCanonical[0].blocks || []).toContain(target[0].id);

    // Suppress unused in strict mode if create ordering changes in future.
    expect(a[0].id || "").toBeDefined();
  });
});
