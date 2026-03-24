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
  mode:
    | "upload_roundtrip"
    | "detached_attachment_append"
    | "detached_attachment_idempotent"
    | "stale_description_media_prune"
    | "pending_description_media_preserve"
    | "stale_attachment_media_prune"
    | "canonical_description_preserve"
    | "startup_media_cache_repair"
    | "startup_media_cache_repair_pending_skip"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import { cacheIssue, cacheMediaItem, getMediaItem, listMediaItemsForIssue, queueOutboxItem } from ${JSON.stringify(DATABASE_UTILS_PATH)};
    import { reconcileIssueMediaCacheWithRemote, renderDescriptionWithCanonicalMedia, repairCachedMediaRegistryFromIssueCache, toLinearRichDescription } from ${JSON.stringify(LINEAR_UTILS_PATH)};

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

    if (mode === "stale_description_media_prune") {
      cacheIssue({
        id: "LIN-5002",
        title: "Description prune",
        description: "Body",
        status: "open",
        priority: 2,
        created_at: now,
        updated_at: now,
      });
      cacheMediaItem({
        id: "m_stale_desc001",
        issue_local_id: "LIN-5002",
        kind: "image",
        label: "old.png",
        source: "description",
        original_filename: "old.png",
        remote_url: "https://uploads.linear.app/old.png",
      });

      reconcileIssueMediaCacheWithRemote("LIN-5002", {
        description: "Body",
      });
      console.log(JSON.stringify({
        media: listMediaItemsForIssue("LIN-5002"),
      }));
      process.exit(0);
    }

    if (mode === "pending_description_media_preserve") {
      cacheIssue({
        id: "LIN-5003",
        title: "Pending prune",
        description: "Body",
        status: "open",
        priority: 2,
        created_at: now,
        updated_at: now,
      });
      cacheMediaItem({
        id: "m_pending_desc001",
        issue_local_id: "LIN-5003",
        kind: "image",
        label: "pending.png",
        source: "description",
        original_filename: "pending.png",
        remote_url: "https://uploads.linear.app/pending.png",
      });
      queueOutboxItem("update", { issueId: "LIN-5003", description: "Body" }, "LIN-5003");

      reconcileIssueMediaCacheWithRemote("LIN-5003", {
        description: "Body",
      });
      console.log(JSON.stringify({
        media: listMediaItemsForIssue("LIN-5003"),
      }));
      process.exit(0);
    }

    if (mode === "stale_attachment_media_prune") {
      cacheIssue({
        id: "LIN-5004",
        title: "Attachment prune",
        description: "Body",
        status: "open",
        priority: 2,
        created_at: now,
        updated_at: now,
      });
      cacheMediaItem({
        id: "m_stale_attach001",
        issue_local_id: "LIN-5004",
        kind: "file",
        label: "old.pdf",
        source: "attachment",
        original_filename: "old.pdf",
        remote_url: "https://uploads.linear.app/old.pdf",
        attachment_id: "att_old",
      });

      reconcileIssueMediaCacheWithRemote("LIN-5004", {
        description: "Body",
        attachments: { nodes: [] },
      });
      console.log(JSON.stringify({
        media: listMediaItemsForIssue("LIN-5004"),
      }));
      process.exit(0);
    }

    if (mode === "canonical_description_preserve") {
      cacheIssue({
        id: "LIN-5005",
        title: "Canonical preserve",
        description: "Body\\n\\n![shot](lb-media:m_canonical001)",
        status: "open",
        priority: 2,
        created_at: now,
        updated_at: now,
      });
      cacheMediaItem({
        id: "m_canonical001",
        issue_local_id: "LIN-5005",
        kind: "image",
        label: "shot",
        source: "description",
        original_filename: "shot.png",
        remote_url: "https://uploads.linear.app/canonical.png",
      });

      const rendered = renderDescriptionWithCanonicalMedia(
        "Body\\n\\n![shot](lb-media:m_canonical001)",
        "LIN-5005"
      );
      console.log(JSON.stringify({
        rendered,
        media: listMediaItemsForIssue("LIN-5005"),
      }));
      process.exit(0);
    }

    if (mode === "startup_media_cache_repair") {
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

      const repaired = repairCachedMediaRegistryFromIssueCache();
      console.log(JSON.stringify({
        repaired,
        repairedMedia: listMediaItemsForIssue("LIN-5006"),
        stagingGone: getMediaItem("m_staging001"),
      }));
      process.exit(0);
    }

    if (mode === "startup_media_cache_repair_pending_skip") {
      cacheIssue({
        id: "LIN-5007",
        title: "Startup repair pending",
        description: "Body",
        status: "open",
        priority: 2,
        created_at: now,
        updated_at: now,
      });
      cacheMediaItem({
        id: "m_pending_startup001",
        issue_local_id: "LIN-5007",
        kind: "image",
        label: "pending.png",
        source: "description",
        original_filename: "pending.png",
        remote_url: "https://uploads.linear.app/pending-startup.png",
      });
      queueOutboxItem("update", { issueId: "LIN-5007", description: "Body" }, "LIN-5007");

      const repaired = repairCachedMediaRegistryFromIssueCache();
      console.log(JSON.stringify({
        repaired,
        media: listMediaItemsForIssue("LIN-5007"),
      }));
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

  test("prunes stale description media when remote text no longer references it", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "stale_description_media_prune");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      media: Array<{ id: string }>;
    };
    expect(payload.media).toEqual([]);
  });

  test("preserves remote-backed description media while a local issue mutation is still pending", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "pending_description_media_preserve");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      media: Array<{ id: string }>;
    };
    expect(payload.media.map((item) => item.id)).toEqual(["m_pending_desc001"]);
  });

  test("prunes stale attachment media when the remote issue no longer lists the attachment", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "stale_attachment_media_prune");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      media: Array<{ id: string }>;
    };
    expect(payload.media).toEqual([]);
  });

  test("does not prune remote-backed media when rendering already-canonical lb-media text", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "canonical_description_preserve");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      rendered: string;
      media: Array<{ id: string }>;
    };
    expect(payload.rendered).toBe("Body\n\n![shot](lb-media:m_canonical001)");
    expect(payload.media.map((item) => item.id)).toEqual(["m_canonical001"]);
  });

  test("startup media repair backfills remote upload rows and drops stale startup leftovers", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "startup_media_cache_repair");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      repaired: number;
      repairedMedia: Array<{ id: string; remote_url?: string }>;
      stagingGone: unknown;
    };
    expect(payload.repaired).toBe(2);
    expect(payload.repairedMedia).toHaveLength(1);
    expect(payload.repairedMedia[0].remote_url).toBe("https://uploads.linear.app/repaired.png");
    expect(payload.stagingGone).toBeNull();
  });

  test("startup media repair skips stale pruning while a local mutation is pending", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "startup_media_cache_repair_pending_skip");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      repaired: number;
      media: Array<{ id: string }>;
    };
    expect(payload.repaired).toBe(0);
    expect(payload.media.map((item) => item.id)).toEqual(["m_pending_startup001"]);
  });
});
