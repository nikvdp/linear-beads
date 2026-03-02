import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createLocalRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-parallel-cli-"));
  tempDirs.push(repoDir);

  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (init.exitCode !== 0) {
    const stderr = init.stderr ? Buffer.from(init.stderr).toString("utf8") : "";
    throw new Error(`Failed to initialize repo: ${stderr}`);
  }

  mkdirSync(join(repoDir, ".lb"), { recursive: true });
  writeFileSync(join(repoDir, ".lb", "config.jsonc"), `${JSON.stringify({ local_only: true })}\n`);
  return repoDir;
}

async function runLb(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, LB_TEAM_KEY: "" },
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
      `lb ${args.join(" ")} failed\nstdout=${result.stdout}\nstderr=${result.stderr}`
    );
  }
  return JSON.parse(result.stdout) as T;
}

describe("parallel CLI concurrency", () => {
  test("parallel show calls do not fail with lock errors", async () => {
    const repoDir = createLocalRepo();
    const first = await runLbJson<Array<{ id: string }>>(repoDir, "create", "Parallel Show A");
    const second = await runLbJson<Array<{ id: string }>>(repoDir, "create", "Parallel Show B");

    const calls: Array<Promise<{ stdout: string; stderr: string; exitCode: number }>> = [];
    for (let i = 0; i < 25; i++) {
      calls.push(runLb(repoDir, "show", first[0].id, "--json"));
      calls.push(runLb(repoDir, "show", second[0].id, "--json"));
    }

    const results = await Promise.all(calls);
    for (const result of results) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toLowerCase()).not.toContain("database is locked");
    }
  });

  test("parallel create/list mix completes without lock errors", async () => {
    const repoDir = createLocalRepo();
    const seed = Date.now();

    const operations: Array<Promise<{ stdout: string; stderr: string; exitCode: number }>> = [];
    for (let i = 0; i < 20; i++) {
      operations.push(runLb(repoDir, "create", `Parallel Create ${seed}-${i}`, "--json"));
      operations.push(runLb(repoDir, "list", "--all", "--json"));
    }

    const results = await Promise.all(operations);
    const createFailures: string[] = [];
    const listFailures: string[] = [];

    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      const stderrLower = result.stderr.toLowerCase();
      expect(stderrLower).not.toContain("database is locked");
      const isListCall = index % 2 === 1;
      if (result.exitCode !== 0) {
        if (isListCall) {
          listFailures.push(result.stderr || result.stdout);
        } else {
          createFailures.push(result.stderr || result.stdout);
        }
      }
    }

    expect(createFailures).toEqual([]);
    expect(listFailures).toEqual([]);

    const finalList = await runLbJson<Array<{ title: string }>>(repoDir, "list", "--all");
    const created = finalList.filter((issue) => issue.title.startsWith(`Parallel Create ${seed}-`));
    expect(created.length).toBe(20);
  });
});
