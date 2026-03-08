import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const LINEAR_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "linear.ts");
const DATABASE_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "database.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-linear-media-"));
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

async function runEval(
  cwd: string,
  mode: "upload_roundtrip" | "detached_attachment_append" | "detached_attachment_idempotent"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import { cacheIssue, cacheMediaItem, getMediaItem } from ${JSON.stringify(DATABASE_UTILS_PATH)};
    import { renderDescriptionWithCanonicalMedia, toLinearRichDescription } from ${JSON.stringify(LINEAR_UTILS_PATH)};

    const mode = process.argv[1];
    const now = "2026-03-09T00:00:00.000Z";
    const repoDir = process.cwd();

    if (mode === "upload_roundtrip") {
      const imagePath = ${JSON.stringify(join("__REPO__", "shot.png"))}.replace("__REPO__", repoDir);
      const filePath = ${JSON.stringify(join("__REPO__", "spec.txt"))}.replace("__REPO__", repoDir);

      cacheMediaItem({
        id: "m_image001",
        kind: "image",
        label: "Shot",
        source: "description",
        original_filename: "shot.png",
        mime_type: "image/png",
        byte_size: 68,
        local_path: imagePath,
      });
      cacheMediaItem({
        id: "m_file001",
        kind: "file",
        label: "Spec",
        source: "description",
        original_filename: "spec.txt",
        mime_type: "text/plain",
        byte_size: 5,
        local_path: filePath,
      });

      const uploads = [];
      globalThis.fetch = async (input, init) => {
        uploads.push({
          url: String(input),
          method: init?.method || "GET",
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
        return new Response("", { status: 200 });
      };

      const fakeClient = {
        async request(query, variables = {}) {
          if (query.includes("mutation FileUpload")) {
            return {
              fileUpload: {
                uploadFile: {
                  uploadUrl: "https://upload.invalid/" + variables.filename,
                  assetUrl: "https://uploads.linear.app/" + variables.filename,
                  headers: [
                    {
                      key: "Content-Disposition",
                      value: "attachment; filename=\\"" + variables.filename + "\\"",
                    },
                  ],
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

          throw new Error("Unexpected query: " + query.slice(0, 80));
        },
      };

      const linear = await toLinearRichDescription(
        "Media ![Shot](lb-media:m_image001) and [Spec](lb-media:m_file001)",
        { client: fakeClient }
      );
      const rendered = renderDescriptionWithCanonicalMedia(linear);

      console.log(JSON.stringify({
        linear,
        rendered,
        image: getMediaItem("m_image001"),
        file: getMediaItem("m_file001"),
        uploads,
      }));
      process.exit(0);
    }

    if (mode === "detached_attachment_append") {
      cacheIssue({
        id: "LIN-5000",
        title: "Attachment parent",
        description: "Body",
        status: "open",
        priority: 2,
        created_at: now,
        updated_at: now,
      });
      cacheMediaItem({
        id: "m_attach001",
        issue_local_id: "LIN-5000",
        kind: "file",
        label: "spec.pdf",
        source: "attachment",
        original_filename: "spec.pdf",
        remote_url: "https://uploads.linear.app/spec.pdf",
      });

      console.log(JSON.stringify({
        rendered: renderDescriptionWithCanonicalMedia("Body", "LIN-5000"),
      }));
      process.exit(0);
    }

    if (mode === "detached_attachment_idempotent") {
      cacheIssue({
        id: "LIN-5001",
        title: "Attachment parent",
        description: "Body",
        status: "open",
        priority: 2,
        created_at: now,
        updated_at: now,
      });
      cacheMediaItem({
        id: "m_attach002",
        issue_local_id: "LIN-5001",
        kind: "file",
        label: "detached.txt",
        source: "attachment",
        original_filename: "detached.txt",
        remote_url: "https://uploads.linear.app/detached.txt",
      });

      const once = renderDescriptionWithCanonicalMedia("Body", "LIN-5001");
      const twice = renderDescriptionWithCanonicalMedia(once, "LIN-5001");

      console.log(JSON.stringify({ once, twice }));
      process.exit(0);
    }
  `;

  const proc = Bun.spawn(["bun", "--eval", script, mode], {
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

describe("Linear media adapter", () => {
  test("uploads canonical lb-media tokens and renders uploaded URLs back to canonical form", async () => {
    const repoDir = createRepo();
    writeFileSync(
      join(repoDir, "shot.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z8ioAAAAASUVORK5CYII=",
        "base64"
      )
    );
    writeFileSync(join(repoDir, "spec.txt"), "spec\n");

    const result = await runEval(repoDir, "upload_roundtrip");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      linear: string;
      rendered: string;
      image: { remote_url: string };
      file: { remote_url: string };
      uploads: Array<{ url: string; method: string; headers: Record<string, string> }>;
    };

    expect(payload.linear).toBe(
      "Media ![Shot](https://uploads.linear.app/shot.png) and [Spec](https://uploads.linear.app/spec.txt)"
    );
    expect(payload.rendered).toBe(
      "Media ![Shot](lb-media:m_image001) and [Spec](lb-media:m_file001)"
    );
    expect(payload.image.remote_url).toBe("https://uploads.linear.app/shot.png");
    expect(payload.file.remote_url).toBe("https://uploads.linear.app/spec.txt");
    expect(payload.uploads).toHaveLength(2);
    expect(payload.uploads.every((upload) => upload.method === "PUT")).toBe(true);
    expect(payload.uploads[0].headers["content-disposition"]).toBeDefined();
  });

  test("appends detached attachments after the rendered description body", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "detached_attachment_append");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as { rendered: string };
    expect(payload.rendered).toBe("Body\n\n[spec.pdf](lb-media:m_attach001)");
  });

  test("does not append detached attachments a second time when rerendering canonical text", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "detached_attachment_idempotent");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as { once: string; twice: string };
    expect(payload.once).toBe("Body\n\n[detached.txt](lb-media:m_attach002)");
    expect(payload.twice).toBe(payload.once);
  });
});
