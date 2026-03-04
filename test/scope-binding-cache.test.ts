import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tempDirs: string[] = [];
const DATABASE_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "database.ts");

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-scope-binding-cache-"));
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
  return repoDir;
}

async function runEval(cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import {
      cacheLabel,
      cacheProject,
      getLabelIdByName,
      getProjectIdByName,
    } from ${JSON.stringify(DATABASE_UTILS_PATH)};
    import { Database } from "bun:sqlite";

    const teamA = "team-a";
    const teamB = "team-b";

    const labelA = "11111111-1111-4111-8111-111111111111";
    const labelB = "22222222-2222-4222-8222-222222222222";
    const projectA = "33333333-3333-4333-8333-333333333333";
    const projectB = "44444444-4444-4444-8444-444444444444";

    cacheLabel(labelA, "repo:demo", teamA);
    cacheLabel(labelB, "repo:demo", teamB);
    cacheLabel("bad-label-id", "repo:bad", teamA);

    cacheProject(projectA, "demo-project", teamA);
    cacheProject(projectB, "demo-project", teamB);
    cacheProject("bad-project-id", "bad-project", teamA);

    const selectedLabelA = getLabelIdByName("repo:demo", teamA);
    const selectedLabelB = getLabelIdByName("repo:demo", teamB);
    const selectedProjectA = getProjectIdByName("demo-project", teamA);
    const selectedProjectB = getProjectIdByName("demo-project", teamB);

    const badLabelLookup = getLabelIdByName("repo:bad", teamA);
    const badProjectLookup = getProjectIdByName("bad-project", teamA);

    const verifyDb = new Database(".lb/cache.db", { readonly: true });
    const badLabelRow = verifyDb.query("SELECT id FROM labels WHERE name = 'repo:bad' LIMIT 1").get();
    const badProjectRow = verifyDb
      .query("SELECT id FROM projects WHERE name = 'bad-project' LIMIT 1")
      .get();
    verifyDb.close();

    console.log(
      JSON.stringify({
        selectedLabelA,
        selectedLabelB,
        selectedProjectA,
        selectedProjectB,
        badLabelLookup,
        badProjectLookup,
        badLabelRow,
        badProjectRow,
      })
    );
  `;

  const proc = Bun.spawn(["bun", "--eval", script], {
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

describe("scope binding cache lookups", () => {
  test("scopes label/project cache hits by team and drops invalid UUID entries", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      selectedLabelA: string | null;
      selectedLabelB: string | null;
      selectedProjectA: string | null;
      selectedProjectB: string | null;
      badLabelLookup: string | null;
      badProjectLookup: string | null;
      badLabelRow: { id: string } | null;
      badProjectRow: { id: string } | null;
    };

    expect(payload.selectedLabelA).toBe("11111111-1111-4111-8111-111111111111");
    expect(payload.selectedLabelB).toBe("22222222-2222-4222-8222-222222222222");
    expect(payload.selectedProjectA).toBe("33333333-3333-4333-8333-333333333333");
    expect(payload.selectedProjectB).toBe("44444444-4444-4444-8444-444444444444");

    expect(payload.badLabelLookup).toBeNull();
    expect(payload.badProjectLookup).toBeNull();
    expect(payload.badLabelRow).toBeNull();
    expect(payload.badProjectRow).toBeNull();
  });
});
