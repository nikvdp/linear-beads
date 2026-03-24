import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const DATABASE_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "database.ts");
const LINEAR_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "linear.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createLocalRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-media-cli-"));
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

async function runCli(
  cwd: string,
  args: string[]
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

async function runEval(
  cwd: string,
  scriptBody: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "--eval", scriptBody], {
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

describe("media CLI flow", () => {
  test("create appends canonical media tokens and caches the media row", async () => {
    const repoDir = createLocalRepo();
    const imagePath = join(repoDir, "shot.png");
    writeFileSync(imagePath, "fake image bytes");

    const created = await runCli(repoDir, [
      "create",
      "Media create",
      "--media",
      imagePath,
      "--json",
    ]);
    expect(created.exitCode).toBe(0);

    const issue = JSON.parse(created.stdout)[0] as { id: string; description?: string };
    expect(issue.id).toMatch(/^LOCAL-/);
    expect(issue.description).toMatch(/!\[shot\.png\]\(lb-media:m_[A-Za-z0-9]{10}\)/);

    const inspected = await runEval(
      repoDir,
      `
        import { listMediaItemsForIssue } from ${JSON.stringify(DATABASE_UTILS_PATH)};
        console.log(JSON.stringify(listMediaItemsForIssue(${JSON.stringify(issue.id)})));
      `
    );
    expect(inspected.exitCode).toBe(0);

    const media = JSON.parse(inspected.stdout) as Array<{
      id: string;
      original_filename: string;
      local_path: string;
    }>;
    expect(media).toHaveLength(1);
    expect(media[0].original_filename).toBe("shot.png");
    expect(media[0].local_path).toBe(imagePath);
  });

  test("update without an explicit description appends new media at the bottom", async () => {
    const repoDir = createLocalRepo();
    const filePath = join(repoDir, "notes.txt");
    writeFileSync(filePath, "notes");

    const created = await runCli(repoDir, [
      "create",
      "Media update",
      "-d",
      "Intro paragraph",
      "--json",
    ]);
    const issue = JSON.parse(created.stdout)[0] as { id: string };

    const updated = await runCli(repoDir, ["update", issue.id, "--media", filePath, "--json"]);
    expect(updated.exitCode).toBe(0);

    const payload = JSON.parse(updated.stdout)[0] as { description?: string };
    expect(payload.description).toContain("Intro paragraph\n\n[notes.txt](lb-media:");
  });

  test("rejects descriptions that reference unknown media ids", async () => {
    const repoDir = createLocalRepo();
    const result = await runCli(repoDir, [
      "create",
      "Broken media",
      "-d",
      "See ![missing](lb-media:m_missing001)",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Description references media id 'm_missing001'");
  });

  test("show prints a media note and includes detached attachments inline when present", async () => {
    const repoDir = createLocalRepo();

    const created = await runCli(repoDir, ["create", "Attachment owner", "-d", "Body", "--json"]);
    const issue = JSON.parse(created.stdout)[0] as { id: string };

    const seeded = await runEval(
      repoDir,
      `
        import { cacheMediaItem } from ${JSON.stringify(DATABASE_UTILS_PATH)};
        cacheMediaItem({
          id: "m_attach001",
          issue_local_id: ${JSON.stringify(issue.id)},
          source: "attachment",
          kind: "file",
          label: "report.pdf",
          original_filename: "report.pdf",
          remote_url: "https://uploads.linear.app/example/report.pdf",
        });
      `
    );
    expect(seeded.exitCode).toBe(0);

    const shown = await runCli(repoDir, ["show", issue.id]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("Media: 1 item (use 'lb media' to retrieve them)");
    expect(shown.stdout).toContain("[report.pdf](lb-media:m_attach001)");
  });

  test("show omits the media note when the issue has no media", async () => {
    const repoDir = createLocalRepo();
    const created = await runCli(repoDir, ["create", "Plain ticket", "-d", "Body", "--json"]);
    const issue = JSON.parse(created.stdout)[0] as { id: string };

    const shown = await runCli(repoDir, ["show", issue.id]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).not.toContain("use 'lb media' to retrieve them");
  });

  test("repo-backed commands auto-heal stale startup media rows before rendering", async () => {
    const repoDir = createLocalRepo();

    const seeded = await runEval(
      repoDir,
      `
        import { cacheIssue, cacheMediaItem, getMediaItem, listMediaItemsForIssue } from ${JSON.stringify(DATABASE_UTILS_PATH)};

        const now = "2026-03-09T00:00:00.000Z";
        cacheIssue({
          id: "LIN-5006",
          title: "Startup repair",
          description: "Body\\n\\n![shot](https://uploads.linear.app/repaired.png)",
          status: "open",
          priority: 2,
          created_at: now,
          updated_at: now,
        });
        cacheMediaItem({
          id: "m_stale_startup001",
          issue_local_id: "LIN-5006",
          kind: "image",
          label: "stale.png",
          source: "description",
          original_filename: "stale.png",
          remote_url: "https://uploads.linear.app/stale.png",
        });
        cacheMediaItem({
          id: "m_staging001",
          issue_local_id: "MEDIA-STAGING-old-run",
          kind: "image",
          label: "staging.png",
          source: "description",
          original_filename: "staging.png",
          local_path: "/tmp/staging.png",
        });

        console.log(JSON.stringify({
          before: listMediaItemsForIssue("LIN-5006"),
          stagingBefore: getMediaItem("m_staging001"),
        }));
      `
    );
    expect(seeded.exitCode).toBe(0);

    const shown = await runCli(repoDir, ["show", "LIN-5006"]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("Media: 1 item (use 'lb media' to retrieve them)");
    expect(shown.stdout).toContain("![shot](lb-media:");
    expect(shown.stdout).not.toContain("stale.png");

    const repaired = await runEval(
      repoDir,
      `
        import { getMediaItem, listMediaItemsForIssue } from ${JSON.stringify(DATABASE_UTILS_PATH)};
        console.log(JSON.stringify({
          media: listMediaItemsForIssue("LIN-5006"),
          stagingGone: getMediaItem("m_staging001"),
        }));
      `
    );
    expect(repaired.exitCode).toBe(0);

    const payload = JSON.parse(repaired.stdout) as {
      media: Array<{ id: string; remote_url?: string }>;
      stagingGone: unknown;
    };
    expect(payload.media).toHaveLength(1);
    expect(payload.media[0].remote_url).toBe("https://uploads.linear.app/repaired.png");
    expect(payload.stagingGone).toBeNull();
  });

  test("lb media info and get work for cached local media", async () => {
    const repoDir = createLocalRepo();
    const sourcePath = join(repoDir, "report.txt");
    const outputPath = join(repoDir, "copied-report.txt");
    writeFileSync(sourcePath, "hello media");

    const seeded = await runEval(
      repoDir,
      `
        import { cacheMediaItem } from ${JSON.stringify(DATABASE_UTILS_PATH)};
        cacheMediaItem({
          id: "m_file001",
          issue_local_id: "LOCAL-500",
          source: "description",
          kind: "file",
          label: "report.txt",
          original_filename: "report.txt",
          local_path: ${JSON.stringify(sourcePath)},
        });
      `
    );
    expect(seeded.exitCode).toBe(0);

    const info = await runCli(repoDir, ["media", "info", "m_file001", "--json"]);
    expect(info.exitCode).toBe(0);
    expect(JSON.parse(info.stdout).id).toBe("m_file001");

    const got = await runCli(repoDir, ["media", "get", "m_file001", outputPath]);
    expect(got.exitCode).toBe(0);
    expect(got.stdout.trim()).toBe(outputPath);
    expect(readFileSync(outputPath, "utf8")).toBe("hello media");
  });

  test("lb media open prints the target it opened for local media", async () => {
    const repoDir = createLocalRepo();
    const sourcePath = join(repoDir, "open-me.txt");
    writeFileSync(sourcePath, "open me");

    const seeded = await runEval(
      repoDir,
      `
        import { cacheMediaItem } from ${JSON.stringify(DATABASE_UTILS_PATH)};
        cacheMediaItem({
          id: "m_open001",
          issue_local_id: "LOCAL-600",
          source: "description",
          kind: "file",
          label: "open-me.txt",
          original_filename: "open-me.txt",
          local_path: ${JSON.stringify(sourcePath)},
        });
      `
    );
    expect(seeded.exitCode).toBe(0);

    const fakeBinDir = join(repoDir, "fake-bin");
    mkdirSync(fakeBinDir);
    const openScriptPath = join(fakeBinDir, "open");
    writeFileSync(openScriptPath, '#!/bin/sh\nprintf \'%s\' "$1" > "$LB_OPEN_CAPTURE_PATH"\n', {
      mode: 0o755,
    });

    const capturePath = join(repoDir, "opened-path.txt");
    const proc = Bun.spawn(["bun", "run", CLI_PATH, "media", "open", "m_open001"], {
      cwd: repoDir,
      env: {
        ...process.env,
        LB_TEAM_KEY: "",
        LINEAR_API_KEY: "",
        LB_OPEN_CAPTURE_PATH: capturePath,
        PATH: `${fakeBinDir}:${process.env.PATH || ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(sourcePath);
    expect(readFileSync(capturePath, "utf8")).toBe(sourcePath);
  });
});

describe("media upload encoding", () => {
  test("uploads canonical lb-media tokens to Linear asset URLs before writing descriptions", async () => {
    const repoDir = createLocalRepo();
    const sourcePath = join(repoDir, "diagram.png");
    writeFileSync(sourcePath, "png bytes");

    const result = await runEval(
      repoDir,
      `
        import { cacheMediaItem } from ${JSON.stringify(DATABASE_UTILS_PATH)};
        import { toLinearRichDescription } from ${JSON.stringify(LINEAR_UTILS_PATH)};

        const uploads: Array<{ method: string; body: string }> = [];
        const server = Bun.serve({
          port: 0,
          fetch(req) {
            uploads.push({
              method: req.method,
              body: req.method === "PUT" ? "uploaded" : "",
            });
            return new Response("ok");
          },
        });

        cacheMediaItem({
          id: "m_img001",
          issue_local_id: "LOCAL-100",
          source: "description",
          kind: "image",
          label: "diagram",
          original_filename: "diagram.png",
          mime_type: "image/png",
          byte_size: 9,
          local_path: ${JSON.stringify(sourcePath)},
        });

        const fakeClient = {
          async request(query, variables = {}) {
            if (query.includes("mutation FileUpload")) {
              return {
                fileUpload: {
                  uploadFile: {
                    uploadUrl: "http://127.0.0.1:" + server.port + "/upload",
                    assetUrl: "https://uploads.linear.app/example/diagram.png",
                    headers: [],
                    filename: variables.filename,
                    contentType: variables.contentType,
                    size: variables.size,
                  },
                },
              };
            }

            if (query.includes("GetWorkspaceUrlKey")) {
              return {
                viewer: {
                  url: "https://linear.app/linear-beads",
                  organization: { urlKey: "linear-beads" },
                },
              };
            }

            throw new Error("Unexpected query: " + query);
          },
        };

        const output = await toLinearRichDescription("See ![diagram](lb-media:m_img001)", {
          client: fakeClient,
          workspaceUrlKey: "linear-beads",
        });
        server.stop(true);
        console.log(JSON.stringify({ output, uploads }));
      `
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      output: string;
      uploads: Array<{ method: string; body?: string }>;
    };

    expect(payload.output).toBe("See ![diagram](https://uploads.linear.app/example/diagram.png)");
    expect(payload.uploads).toEqual([{ method: "PUT", body: "uploaded" }]);
  });
});
