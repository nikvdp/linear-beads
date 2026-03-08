/**
 * lb media - Inspect and retrieve cached issue media
 */

import { copyFile } from "node:fs/promises";
import { platform } from "os";
import { existsSync } from "fs";
import { resolve } from "path";
import { Command } from "commander";
import { getApiKey } from "../utils/config.js";
import { getMediaItem } from "../utils/database.js";
import { linearFetchWithRetry } from "../utils/graphql.js";
import { output, outputError } from "../utils/output.js";

const LINEAR_UPLOAD_HOST = "uploads.linear.app";

function defaultOutputPath(mediaId: string, originalFilename?: string, localPath?: string): string {
  if (originalFilename?.trim()) {
    return resolve(originalFilename.trim());
  }
  if (localPath?.trim()) {
    return resolve(localPath);
  }
  return resolve(mediaId);
}

function mediaOpenTarget(media: ReturnType<typeof getMediaItem>): string | null {
  if (!media) {
    return null;
  }
  return media.local_path || media.remote_url || null;
}

function openCommandForCurrentPlatform(): string[] | null {
  if (platform() === "darwin") {
    return ["open"];
  }
  if (platform() === "linux") {
    return ["xdg-open"];
  }
  return null;
}

export function mediaDownloadHeadersForUrl(
  rawUrl: string,
  apiKeyOverride?: string
): HeadersInit | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }

  if (parsed.hostname.toLowerCase() !== LINEAR_UPLOAD_HOST) {
    return undefined;
  }

  return {
    Authorization: apiKeyOverride || getApiKey(),
  };
}

export const mediaCommand = new Command("media").description(
  "Inspect and retrieve issue media by lb media id"
);

mediaCommand
  .command("info")
  .description("Show metadata for a media item")
  .argument("<id>", "Media id")
  .option("-j, --json", "Output as JSON")
  .action((id: string, options) => {
    const media = getMediaItem(id);
    if (!media) {
      outputError(`Media not found: ${id}`);
      process.exit(1);
    }

    if (options.json) {
      output(JSON.stringify(media, null, 2));
      return;
    }

    const lines = [
      `${media.id}: ${media.label || media.original_filename || media.id}`,
      `  Kind: ${media.kind}`,
      `  Source: ${media.source}`,
      `  Issue: ${media.issue_local_id || "(unowned)"}`,
    ];
    if (media.original_filename) {
      lines.push(`  Original filename: ${media.original_filename}`);
    }
    if (media.mime_type) {
      lines.push(`  MIME type: ${media.mime_type}`);
    }
    if (media.byte_size !== undefined) {
      lines.push(`  Size: ${media.byte_size}`);
    }
    if (media.remote_url) {
      lines.push(`  Remote URL: ${media.remote_url}`);
    }
    if (media.local_path) {
      lines.push(`  Local path: ${media.local_path}`);
    }

    output(lines.join("\n"));
  });

mediaCommand
  .command("get")
  .description("Download or copy a media item to a local file")
  .argument("<id>", "Media id")
  .argument("[output_path]", "Output path (defaults to original filename or media id)")
  .option("--force", "Overwrite an existing output file")
  .action(async (id: string, outputPath: string | undefined, options) => {
    const media = getMediaItem(id);
    if (!media) {
      outputError(`Media not found: ${id}`);
      process.exit(1);
    }

    const targetPath = outputPath
      ? resolve(outputPath)
      : defaultOutputPath(media.id, media.original_filename, media.local_path);

    if (existsSync(targetPath) && !options.force) {
      outputError(`Output file already exists: ${targetPath}`);
      process.exit(1);
    }

    if (media.local_path && !media.remote_url) {
      await copyFile(media.local_path, targetPath);
      output(targetPath);
      return;
    }

    if (!media.remote_url) {
      outputError(`Media '${id}' has no remote URL or local file path to retrieve.`);
      process.exit(1);
    }

    const response = await linearFetchWithRetry(media.remote_url, {
      headers: mediaDownloadHeadersForUrl(media.remote_url),
    });
    if (!response.ok) {
      outputError(`Failed to download media '${id}': ${response.status}`);
      process.exit(1);
    }

    const bytes = await response.bytes();
    await Bun.write(targetPath, bytes);
    output(targetPath);
  });

mediaCommand
  .command("open")
  .description("Open a media item using the local OS handler")
  .argument("<id>", "Media id")
  .action(async (id: string) => {
    const media = getMediaItem(id);
    if (!media) {
      outputError(`Media not found: ${id}`);
      process.exit(1);
    }

    const target = mediaOpenTarget(media);
    if (!target) {
      outputError(`Media '${id}' has no local path or remote URL to open.`);
      process.exit(1);
    }

    const openCommand = openCommandForCurrentPlatform();
    if (!openCommand) {
      outputError("lb media open is only supported on macOS and Linux.");
      process.exit(1);
    }

    const proc = Bun.spawn([...openCommand, target], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      outputError(stderr.trim() || `Failed to open media '${id}'.`);
      process.exit(1);
    }

    output(target);
  });
