import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseReleaseTag } from "../src/utils/release-version.js";
import { getRuntimeCliVersion } from "../src/utils/runtime-version.js";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(minCliVersion: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-min-cli-gate-"));
  tempDirs.push(repoDir);

  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (init.exitCode !== 0) {
    const stderr = init.stderr ? Buffer.from(init.stderr).toString("utf8") : "";
    throw new Error(`Failed to init git repo: ${stderr}`);
  }

  mkdirSync(join(repoDir, ".lb"), { recursive: true });
  writeFileSync(
    join(repoDir, ".lb", "config.jsonc"),
    `${JSON.stringify({ local_only: true, min_cli_version: minCliVersion }, null, 2)}\n`
  );

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

describe("min cli version gate", () => {
  const currentVersion = getRuntimeCliVersion();
  const currentOrder = parseReleaseTag(currentVersion);
  if (currentOrder === undefined) {
    throw new Error(`Unable to parse current runtime version '${currentVersion}'`);
  }

  test("rejects commands when repo min_cli_version is higher than current binary", async () => {
    const repoDir = createRepo(`v${currentOrder + 1}`);
    const result = await runLb(repoDir, "list", "--all");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`requires lb v${currentOrder + 1} or newer`);
    expect(result.stderr).toContain("Current binary is");
    expect(result.stderr).toContain("lb self-update");
  });

  test("allows commands when current binary exactly matches repo min_cli_version", async () => {
    const repoDir = createRepo(currentVersion);
    const result = await runLb(repoDir, "list", "--all");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});
