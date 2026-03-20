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
  const repoDir = mkdtempSync(join(tmpdir(), "lb-placeholder-inputs-"));
  tempDirs.push(repoDir);

  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (init.exitCode !== 0) {
    throw new Error("Failed to initialize git repo");
  }

  mkdirSync(join(repoDir, ".lb"), { recursive: true });
  writeFileSync(join(repoDir, ".lb", "config.jsonc"), '{ "local_only": true }\n');
  return repoDir;
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
      LINEAR_API_KEY: "",
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
      `lb ${args.join(" ")} failed\nstdout=${result.stdout}\nstderr=${result.stderr}`
    );
  }
  return JSON.parse(result.stdout) as T;
}

describe("placeholder issue ref handling", () => {
  test("create treats --parent - as an unset parent instead of queueing a bogus ref", async () => {
    const repoDir = createLocalRepo();

    const created = await runLbJson<Array<{ id: string }>>(
      repoDir,
      "create",
      "Child issue",
      "--parent",
      "-"
    );
    const shown = await runLbJson<Array<{ parent: string | null }>>(repoDir, "show", created[0].id);

    expect(created[0].id).toMatch(/^LOCAL-\d+$/);
    expect(shown[0].parent).toBeNull();
  });

  test("create rejects placeholder dependency targets", async () => {
    const repoDir = createLocalRepo();
    const result = await runLb(repoDir, "create", "Bad dependency", "--blocks", "-");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--blocks requires a real issue ID");
  });

  test("dep add rejects placeholder parent ids", async () => {
    const repoDir = createLocalRepo();
    const created = await runLbJson<Array<{ id: string }>>(repoDir, "create", "Parentless child");
    const result = await runLb(repoDir, "dep", "add", created[0].id, "--parent", "-");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--parent requires a real issue ID");
  });
});
