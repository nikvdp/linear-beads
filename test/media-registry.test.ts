import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildLbMediaTarget,
  collectCanonicalMediaTokens,
  renderCanonicalMediaToken,
  renderIssueLinksAsPlainText,
  rewriteCanonicalMediaTokensOutsideBackticks,
} from "../src/utils/linear.js";

const DATABASE_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "database.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-media-registry-"));
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
  mode: "cache_media_rows" | "generate_media_ids"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import {
      cacheIssue,
      cacheMediaItem,
      generateMediaId,
      getMediaItem,
      getMediaItemByLinearAttachmentId,
      getMediaItemByRemoteUrl,
      listMediaItemsForIssue,
      replaceIssueId
    } from ${JSON.stringify(DATABASE_UTILS_PATH)};

    const mode = process.argv[1];
    const now = "2026-03-09T00:00:00.000Z";

    if (mode === "cache_media_rows") {
      cacheIssue({
        id: "LOCAL-101",
        title: "Media parent",
        description: "parent",
        status: "open",
        priority: 2,
        created_at: now,
        updated_at: now,
      });

      cacheMediaItem({
        id: "m_image001",
        issue_local_id: "LOCAL-101",
        kind: "image",
        label: "Screenshot",
        source: "description",
        original_filename: "shot.png",
        mime_type: "image/png",
        byte_size: 128,
        local_path: "/tmp/shot.png",
        remote_url: "https://uploads.linear.app/test-shot.png",
      });

      cacheMediaItem({
        id: "m_file001",
        issue_local_id: "LOCAL-101",
        kind: "file",
        label: "Spec",
        source: "attachment",
        original_filename: "spec.pdf",
        mime_type: "application/pdf",
        byte_size: 512,
        remote_url: "https://uploads.linear.app/test-spec.pdf",
        attachment_id: "attach-123",
      });

      replaceIssueId("LOCAL-101", "LIN-5101", "uuid-5101");

      console.log(JSON.stringify({
        image: getMediaItem("m_image001"),
        byRemoteUrl: getMediaItemByRemoteUrl("https://uploads.linear.app/test-shot.png"),
        byAttachmentId: getMediaItemByLinearAttachmentId("attach-123"),
        viaLocalId: listMediaItemsForIssue("LOCAL-101"),
        viaLinearId: listMediaItemsForIssue("LIN-5101"),
      }));
      process.exit(0);
    }

    if (mode === "generate_media_ids") {
      const explicit = generateMediaId("m_manual123");
      cacheMediaItem({
        id: explicit,
        issue_local_id: "LOCAL-200",
        kind: "file",
        source: "description",
        original_filename: "notes.txt",
      });

      let invalidError = "";
      try {
        generateMediaId("bad id with spaces");
      } catch (error) {
        invalidError = error instanceof Error ? error.message : String(error);
      }

      const generated = generateMediaId("m_manual123");
      console.log(JSON.stringify({ explicit, generated, invalidError }));
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

describe("media registry storage", () => {
  test("stores media metadata and resolves it through local and synced issue identities", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "cache_media_rows");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      image: { source: string; label: string; issue_local_id: string; byte_size: number };
      byRemoteUrl: { id: string };
      byAttachmentId: { id: string; source: string };
      viaLocalId: Array<{ id: string }>;
      viaLinearId: Array<{ id: string }>;
    };

    expect(payload.image.source).toBe("description");
    expect(payload.image.label).toBe("Screenshot");
    expect(payload.image.issue_local_id).toBe("LOCAL-101");
    expect(payload.image.byte_size).toBe(128);
    expect(payload.byRemoteUrl.id).toBe("m_image001");
    expect(payload.byAttachmentId.id).toBe("m_file001");
    expect(payload.byAttachmentId.source).toBe("attachment");
    expect(payload.viaLocalId.map((item) => item.id).sort()).toEqual(["m_file001", "m_image001"]);
    expect(payload.viaLinearId.map((item) => item.id).sort()).toEqual(["m_file001", "m_image001"]);
  });

  test("honors explicit media ids, rejects invalid ones, and auto-generates on collision", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "generate_media_ids");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      explicit: string;
      generated: string;
      invalidError: string;
    };

    expect(payload.explicit).toBe("m_manual123");
    expect(payload.generated).toMatch(/^m_[A-Za-z0-9]{10}$/);
    expect(payload.generated).not.toBe(payload.explicit);
    expect(payload.invalidError).toContain("Invalid media id");
  });
});

describe("canonical lb-media tokens", () => {
  test("renders and collects markdown-style lb-media tokens", () => {
    const image = renderCanonicalMediaToken({
      mediaId: "m_image123",
      kind: "image",
      label: "Screenshot",
    });
    const file = renderCanonicalMediaToken({
      mediaId: "m_file123",
      kind: "file",
      label: "Spec",
    });
    const description = `${image}\n\n${file}`;

    expect(image).toBe(`![Screenshot](${buildLbMediaTarget("m_image123")})`);
    expect(file).toBe(`[Spec](${buildLbMediaTarget("m_file123")})`);
    expect(collectCanonicalMediaTokens(description)).toEqual([
      {
        full: image,
        label: "Screenshot",
        target: "lb-media:m_image123",
        mediaId: "m_image123",
        kind: "image",
        index: 0,
      },
      {
        full: file,
        label: "Spec",
        target: "lb-media:m_file123",
        mediaId: "m_file123",
        kind: "file",
        index: image.length + 2,
      },
    ]);
  });

  test("rewrites lb-media tokens outside backticks only", () => {
    const description = [
      "Outside ![Screenshot](lb-media:m_image123)",
      "Keep `![Literal](lb-media:m_literal123)` untouched",
      "Outside [Spec](lb-media:m_file123)",
    ].join("\n\n");

    const rewritten = rewriteCanonicalMediaTokensOutsideBackticks(description, (token) =>
      token.kind === "image" ? `<image:${token.mediaId}>` : `<file:${token.mediaId}>`
    );

    expect(rewritten).toContain("Outside <image:m_image123>");
    expect(rewritten).toContain("Outside <file:m_file123>");
    expect(rewritten).toContain("`![Literal](lb-media:m_literal123)`");
  });

  test("keeps canonical lb-media markers literal in plain-text output", () => {
    const description =
      "Media ![Screenshot](lb-media:m_image123) and [Spec](lb-media:m_file123) with [LIN-4084](https://linear.app/linear-beads/issue/LIN-4084)";

    const output = renderIssueLinksAsPlainText(description);
    expect(output).toBe(
      "Media ![Screenshot](lb-media:m_image123) and [Spec](lb-media:m_file123) with LIN-4084"
    );
  });
});
