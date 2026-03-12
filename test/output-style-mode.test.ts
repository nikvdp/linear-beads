import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createLocalRepo(): string {
  const repoDir = createTempDir("lb-output-style-");
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

async function runCli(
  cwd: string,
  args: string[],
  envOverrides?: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      LB_TEAM_KEY: "",
      LINEAR_API_KEY: "",
      ...(envOverrides || {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function createIssue(
  cwd: string,
  title: string,
  extraArgs: string[] = [],
  envOverrides?: Record<string, string>
): Promise<{ id: string }> {
  const result = await runCli(cwd, ["create", title, "--json", ...extraArgs], envOverrides);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout)[0] as { id: string };
}

describe("human output style modes", () => {
  test("list --style beads renders the beads tree layout", async () => {
    const repoDir = createLocalRepo();
    const parent = await createIssue(repoDir, "Parent issue");
    const child = await createIssue(repoDir, "Child issue", ["--parent", parent.id]);

    const listed = await runCli(repoDir, ["list", "--all", "--style", "beads"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain(`○ ${parent.id} ● P2 Parent issue`);
    expect(listed.stdout).toContain(`└── ○ ${child.id} ● P2 Child issue`);
    expect(listed.stdout).toContain("Total: 2 issues");
    expect(listed.stdout).toContain("Status: ○ open");
  });

  test("ready --style beads includes in-progress work ahead of ready work", async () => {
    const repoDir = createLocalRepo();
    const active = await createIssue(repoDir, "Active issue");
    const queued = await createIssue(repoDir, "Ready issue");

    const updated = await runCli(repoDir, ["update", active.id, "--status", "in_progress"]);
    expect(updated.exitCode).toBe(0);

    const ready = await runCli(repoDir, ["ready", "--all", "--style", "beads"]);
    expect(ready.exitCode).toBe(0);

    const activeIndex = ready.stdout.indexOf(`◐ ${active.id} ● P2 Active issue`);
    const readyIndex = ready.stdout.indexOf(`○ ${queued.id} ● P2 Ready issue`);
    expect(activeIndex).toBeGreaterThanOrEqual(0);
    expect(readyIndex).toBeGreaterThan(activeIndex);
    expect(ready.stdout).toContain("Total: 2 issues (1 open, 1 in progress)");
  });

  test("lb style persists the repo default and command flags still override it", async () => {
    const repoDir = createLocalRepo();
    const issue = await createIssue(repoDir, "Styled issue");

    const styled = await runCli(repoDir, ["style", "beads"]);
    expect(styled.exitCode).toBe(0);
    expect(styled.stdout).toContain("Default human output style set to beads.");

    const repoConfig = readFileSync(join(repoDir, ".lb", "config.jsonc"), "utf8");
    expect(repoConfig).toContain('"human_output_style": "beads"');

    const listedDefault = await runCli(repoDir, ["list", "--all"]);
    expect(listedDefault.exitCode).toBe(0);
    expect(listedDefault.stdout).toContain(`○ ${issue.id} ● P2 Styled issue`);
    expect(listedDefault.stdout).toContain("Total: 1 issues (1 open)");

    const listedClassic = await runCli(repoDir, ["list", "--all", "--style", "classic"]);
    expect(listedClassic.exitCode).toBe(0);
    expect(listedClassic.stdout).toContain(`${issue.id}  open`);
    expect(listedClassic.stdout).not.toContain("Total: 1 issues");
  });

  test("show uses beads-style relationship sections when that mode is active", async () => {
    const repoDir = createLocalRepo();
    const blocker = await createIssue(repoDir, "Blocker issue");
    const parent = await createIssue(repoDir, "Parent issue");
    const child = await createIssue(repoDir, "Child issue", ["--parent", parent.id]);

    const dep = await runCli(repoDir, ["dep", "add", parent.id, "--blocked-by", blocker.id]);
    expect(dep.exitCode).toBe(0);

    const styled = await runCli(repoDir, ["style", "beads"]);
    expect(styled.exitCode).toBe(0);

    const shown = await runCli(repoDir, ["show", parent.id]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain(`○ ${parent.id} ● P2 Parent issue`);
    expect(shown.stdout).toContain("Children (1):");
    expect(shown.stdout).toContain(`└── ○ ${child.id} ● P2 Child issue`);
    expect(shown.stdout).toContain("Blocked by (1):");
    expect(shown.stdout).toContain(`└── ○ ${blocker.id} ● P2 Blocker issue`);
  });

  test("blocked and dep views inherit beads mode consistently", async () => {
    const repoDir = createLocalRepo();
    const blocker = await createIssue(repoDir, "Primary blocker");
    const blocked = await createIssue(repoDir, "Blocked item");

    const dep = await runCli(repoDir, ["dep", "add", blocked.id, "--blocked-by", blocker.id]);
    expect(dep.exitCode).toBe(0);

    const styled = await runCli(repoDir, ["style", "beads"]);
    expect(styled.exitCode).toBe(0);

    const blockedView = await runCli(repoDir, ["blocked"]);
    expect(blockedView.exitCode).toBe(0);
    expect(blockedView.stdout).toContain(`● ${blocked.id} ● P2 Blocked item`);
    expect(blockedView.stdout).toContain("Blocked by (1):");
    expect(blockedView.stdout).toContain(`└── ○ ${blocker.id} ● P2 Primary blocker`);

    const depList = await runCli(repoDir, ["dep", "list", blocked.id]);
    expect(depList.exitCode).toBe(0);
    expect(depList.stdout).toContain(`● ${blocked.id} ● P2 Blocked item`);
    expect(depList.stdout).toContain("Blocked by (1):");
    expect(depList.stdout).toContain(`└── ○ ${blocker.id} ● P2 Primary blocker`);

    const depTree = await runCli(repoDir, ["dep", "tree", blocked.id]);
    expect(depTree.exitCode).toBe(0);
    expect(depTree.stdout).toContain(`● ${blocked.id} ● P2 Blocked item`);
    expect(depTree.stdout).toContain(`└── ○ ${blocker.id} ● P2 Primary blocker`);
  });

  test("lb style --global persists a shared default that repos can inherit", async () => {
    const repoDir = createLocalRepo();
    const homeDir = createTempDir("lb-output-style-home-");
    const issue = await createIssue(repoDir, "Global style issue", [], { HOME: homeDir });

    const styled = await runCli(repoDir, ["style", "beads", "--global"], { HOME: homeDir });
    expect(styled.exitCode).toBe(0);

    const globalConfigPath = join(homeDir, ".config", "lb", "config.jsonc");
    const globalConfig = readFileSync(globalConfigPath, "utf8");
    expect(globalConfig).toContain('"human_output_style": "beads"');

    const listed = await runCli(repoDir, ["list", "--all"], { HOME: homeDir });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain(`○ ${issue.id} ● P2 Global style issue`);
  });

  test("create in beads mode uses the same single-issue renderer as other issue commands", async () => {
    const repoDir = createLocalRepo();

    const created = await runCli(repoDir, ["create", "Beads create", "--style", "beads"]);
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("○ LOCAL-");
    expect(created.stdout).toContain("● P2 Beads create");
    expect(created.stdout).not.toContain("Created:");
  });
});
