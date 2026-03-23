import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const DATABASE_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "database.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createLocalRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-media-cli-local-"));
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

function seedSampleFiles(repoDir: string): { imagePath: string; textPath: string } {
  const imagePath = join(repoDir, "shot.png");
  const textPath = join(repoDir, "notes.txt");

  writeFileSync(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z8ioAAAAASUVORK5CYII=",
      "base64"
    )
  );
  writeFileSync(textPath, "hello media\n");

  return { imagePath, textPath };
}

async function lb(
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

async function lbJson<T>(cwd: string, ...args: string[]): Promise<T> {
  const result = await lb(cwd, ...args, "--json");
  if (result.exitCode !== 0) {
    throw new Error(`lb ${args.join(" ")} failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

async function inspectMedia(
  cwd: string,
  issueId: string
): Promise<{
  issueDescription?: string;
  media: Array<{ id: string; kind: string; label?: string; original_filename?: string }>;
}> {
  const script = `
    import { getCachedIssue, listMediaItemsForIssue } from ${JSON.stringify(DATABASE_UTILS_PATH)};
    const issueId = process.argv[1];
    const issue = getCachedIssue(issueId);
    const media = listMediaItemsForIssue(issueId);
    console.log(JSON.stringify({ issueDescription: issue?.description, media }));
  `;

  const proc = Bun.spawn(["bun", "--eval", script, issueId], {
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
  if (exitCode !== 0) {
    throw new Error(stderr || "Failed to inspect media state");
  }
  return JSON.parse(stdout);
}

describe("local media CLI authoring", () => {
  test("pairs ordered media flags with explicit ids and inline markers on create", async () => {
    const repoDir = createLocalRepo();
    const { imagePath, textPath } = seedSampleFiles(repoDir);

    const created = await lbJson<
      Array<{
        id: string;
        description: string;
      }>
    >(
      repoDir,
      "create",
      "Media create",
      "-d",
      "Body\n\n![Shot](lb-media:m_image001)\n\n[Notes](lb-media:m_file001)",
      "--media",
      imagePath,
      "--media-id",
      "m_image001",
      "--media",
      textPath,
      "--media-id",
      "m_file001"
    );

    expect(created[0].description).toContain("![Shot](lb-media:m_image001)");
    expect(created[0].description).toContain("[Notes](lb-media:m_file001)");

    const inspected = await inspectMedia(repoDir, created[0].id);
    expect(inspected.media).toHaveLength(2);
    expect(inspected.media.map((item) => item.id).sort()).toEqual(["m_file001", "m_image001"]);
    expect(inspected.media.find((item) => item.id === "m_image001")?.kind).toBe("image");
    expect(inspected.media.find((item) => item.id === "m_file001")?.kind).toBe("file");
    expect(inspected.media.find((item) => item.id === "m_image001")?.label).toBe("Shot");
    expect(inspected.media.find((item) => item.id === "m_file001")?.label).toBe("Notes");
  });

  test("auto-generates ids and appends canonical tokens when media has no inline marker", async () => {
    const repoDir = createLocalRepo();
    const { imagePath, textPath } = seedSampleFiles(repoDir);

    const created = await lbJson<Array<{ id: string; description: string }>>(
      repoDir,
      "create",
      "Media append create",
      "-d",
      "Body",
      "--media",
      imagePath,
      "--media",
      textPath
    );

    expect(created[0].description).toContain("Body");
    expect(created[0].description).toMatch(/!\[shot\.png\]\(lb-media:m_[A-Za-z0-9]{10}\)/);
    expect(created[0].description).toMatch(/\[notes\.txt\]\(lb-media:m_[A-Za-z0-9]{10}\)/);

    const inspected = await inspectMedia(repoDir, created[0].id);
    expect(inspected.issueDescription).toBe(created[0].description);
    expect(inspected.media).toHaveLength(2);
  });

  test("appends media to the existing description on update instead of replacing it", async () => {
    const repoDir = createLocalRepo();
    const { imagePath } = seedSampleFiles(repoDir);

    const created = await lbJson<Array<{ id: string }>>(
      repoDir,
      "create",
      "Media update",
      "-d",
      "Keep this"
    );
    const updated = await lbJson<Array<{ id: string; description: string }>>(
      repoDir,
      "update",
      created[0].id,
      "--media",
      imagePath
    );

    expect(updated[0].description).toContain("Keep this");
    expect(updated[0].description).toMatch(/!\[shot\.png\]\(lb-media:m_[A-Za-z0-9]{10}\)/);

    const shown = await lbJson<Array<{ description: string }>>(repoDir, "show", created[0].id);
    expect(shown[0].description).toBe(updated[0].description);
  });

  test("show --body prints only the normalized description text", async () => {
    const repoDir = createLocalRepo();

    const created = await lbJson<Array<{ id: string }>>(
      repoDir,
      "create",
      "Body show",
      "-d",
      "Alpha\n\nBeta"
    );
    const shown = await lb(repoDir, "show", created[0].id, "--body");

    expect(shown.exitCode).toBe(0);
    expect(shown.stderr).toBe("");
    expect(shown.stdout).toBe("Alpha\n\nBeta\n");
  });

  test("update --replace matches the same plain body text that show --body emits", async () => {
    const repoDir = createLocalRepo();

    const dependency = await lbJson<Array<{ id: string }>>(repoDir, "create", "Dependency");
    const created = await lbJson<Array<{ id: string }>>(
      repoDir,
      "create",
      "Replace body",
      "-d",
      `Depends on ${dependency[0].id}`
    );

    const inspectedBefore = await inspectMedia(repoDir, created[0].id);
    expect(inspectedBefore.issueDescription).toContain("lb-ref.invalid");

    const shownBefore = await lb(repoDir, "show", created[0].id, "--body");
    expect(shownBefore.stdout).toBe(`Depends on ${dependency[0].id}\n`);

    const updated = await lbJson<Array<{ description: string }>>(
      repoDir,
      "update",
      created[0].id,
      "--replace",
      `Depends on ${dependency[0].id}`,
      "--with",
      "Resolved dependency"
    );

    expect(updated[0].description).toBe("Resolved dependency");

    const shownAfter = await lb(repoDir, "show", created[0].id, "--body");
    expect(shownAfter.stdout).toBe("Resolved dependency\n");
  });

  test("update --replace supports @file values for multiline chunks", async () => {
    const repoDir = createLocalRepo();
    const needlePath = join(repoDir, "needle.md");
    const replacementPath = join(repoDir, "replacement.md");

    writeFileSync(needlePath, "Old block\n\n- one\n- two\n");
    writeFileSync(replacementPath, "New block\n\n- alpha\n- beta\n");

    const created = await lbJson<Array<{ id: string; description: string }>>(
      repoDir,
      "create",
      "Replace from file",
      "-d",
      "Intro\n\nOld block\n\n- one\n- two\n\nOutro"
    );

    const updated = await lbJson<Array<{ description: string }>>(
      repoDir,
      "update",
      created[0].id,
      "--replace",
      `@${needlePath}`,
      "--with",
      `@${replacementPath}`
    );

    expect(updated[0].description).toBe("Intro\n\nNew block\n\n- alpha\n- beta\n\nOutro");
  });

  test("update --replace fails when the needle matches zero times", async () => {
    const repoDir = createLocalRepo();

    const created = await lbJson<Array<{ id: string }>>(
      repoDir,
      "create",
      "No match",
      "-d",
      "Body"
    );
    const result = await lb(
      repoDir,
      "update",
      created[0].id,
      "--replace",
      "Missing",
      "--with",
      "Replacement"
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--replace needle matched 0 times: "Missing"');
  });

  test("update --replace fails when the needle matches more than once", async () => {
    const repoDir = createLocalRepo();

    const created = await lbJson<Array<{ id: string }>>(
      repoDir,
      "create",
      "Too many matches",
      "-d",
      "repeat and repeat"
    );
    const result = await lb(
      repoDir,
      "update",
      created[0].id,
      "--replace",
      "repeat",
      "--with",
      "done"
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--replace needle matched 2 times");
  });

  test("update --replace fails when --with is missing", async () => {
    const repoDir = createLocalRepo();

    const created = await lbJson<Array<{ id: string }>>(
      repoDir,
      "create",
      "Dangling replace",
      "-d",
      "Body"
    );
    const result = await lb(repoDir, "update", created[0].id, "--replace", "Body");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--replace must be followed by --with");
  });

  test("update --replace fails when --with has no preceding --replace", async () => {
    const repoDir = createLocalRepo();

    const created = await lbJson<Array<{ id: string }>>(
      repoDir,
      "create",
      "Orphaned with",
      "-d",
      "Body"
    );
    const result = await lb(repoDir, "update", created[0].id, "--with", "Replacement");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--with requires a preceding --replace");
  });

  test("fails when inline media ids have no matching uploaded file or cached media", async () => {
    const repoDir = createLocalRepo();
    const { imagePath } = seedSampleFiles(repoDir);

    const result = await lb(
      repoDir,
      "create",
      "Broken media create",
      "-d",
      "Broken ![Shot](lb-media:m_missing001)",
      "--media",
      imagePath
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Description references media id 'm_missing001'");
  });

  test("fails when media ids outnumber media paths", async () => {
    const repoDir = createLocalRepo();

    const result = await lb(repoDir, "create", "Bad ids", "--media-id", "m_lonely001");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Each --media-id must pair with a corresponding --media path");
  });
});
