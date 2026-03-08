import { basename, resolve } from "path";
import { collectCanonicalMediaTokens, renderCanonicalMediaToken } from "./linear.js";
import { cacheMediaItem, generateMediaId, getMediaItem, isValidMediaId } from "./database.js";
import type { MediaItem, MediaKind } from "../types.js";

export type PlannedMediaItem = {
  id: string;
  kind: MediaKind;
  label: string;
  original_filename: string;
  mime_type?: string;
  byte_size?: number;
  local_path: string;
};

export type PlannedMediaDescription = {
  description?: string;
  mediaItems: PlannedMediaItem[];
};

const IMAGE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);

function filenameExtension(filename: string): string {
  const normalized = filename.trim().toLowerCase();
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === normalized.length - 1) {
    return "";
  }
  return normalized.slice(lastDot);
}

function inferMediaKind(filename: string, mimeType?: string): MediaKind {
  const normalizedType = mimeType?.trim().toLowerCase();
  if (normalizedType?.startsWith("image/")) {
    return "image";
  }

  if (IMAGE_EXTENSIONS.has(filenameExtension(filename))) {
    return "image";
  }

  return "file";
}

async function readLocalMediaFile(path: string): Promise<{
  localPath: string;
  filename: string;
  mimeType?: string;
  byteSize?: number;
  kind: MediaKind;
}> {
  const localPath = resolve(path);
  const file = Bun.file(localPath);
  if (!(await file.exists())) {
    throw new Error(`Media file not found: ${path}`);
  }

  const filename = basename(localPath);
  const mimeType = file.type || undefined;
  const byteSize = Number.isFinite(file.size) ? file.size : undefined;

  return {
    localPath,
    filename,
    mimeType,
    byteSize,
    kind: inferMediaKind(filename, mimeType),
  };
}

function appendMediaTokens(description: string | undefined, tokens: string[]): string | undefined {
  if (tokens.length === 0) {
    return description;
  }

  if (!description || description.trim() === "") {
    return tokens.join("\n\n");
  }

  return `${description.replace(/\s+$/, "")}\n\n${tokens.join("\n\n")}`;
}

export async function planDescriptionMediaInput(options: {
  description?: string;
  mediaPaths?: string[];
  mediaIds?: string[];
}): Promise<PlannedMediaDescription> {
  const mediaPaths = options.mediaPaths || [];
  const mediaIds = options.mediaIds || [];

  if (mediaIds.length > mediaPaths.length) {
    throw new Error("Each --media-id must pair with a corresponding --media path.");
  }

  const descriptionTokens = options.description
    ? collectCanonicalMediaTokens(options.description)
    : [];
  const tokenById = new Map(descriptionTokens.map((token) => [token.mediaId, token]));
  const stagedIds = new Set<string>();
  const mediaItems: PlannedMediaItem[] = [];

  for (const [index, mediaPath] of mediaPaths.entries()) {
    const explicitId = mediaIds[index]?.trim();
    if (explicitId) {
      if (!isValidMediaId(explicitId)) {
        throw new Error(`Invalid media id '${explicitId}'.`);
      }
      if (stagedIds.has(explicitId)) {
        throw new Error(`Duplicate media id '${explicitId}' in this command.`);
      }
      if (getMediaItem(explicitId)) {
        throw new Error(`Media id '${explicitId}' already exists. Choose a different --media-id.`);
      }
    }

    let mediaId = explicitId || generateMediaId();
    while (stagedIds.has(mediaId)) {
      mediaId = generateMediaId();
    }
    stagedIds.add(mediaId);

    const file = await readLocalMediaFile(mediaPath);
    const referencedToken = tokenById.get(mediaId);
    mediaItems.push({
      id: mediaId,
      kind: file.kind,
      label: referencedToken?.label || file.filename,
      original_filename: file.filename,
      mime_type: file.mimeType,
      byte_size: file.byteSize,
      local_path: file.localPath,
    });
  }

  const plannedIds = new Set(mediaItems.map((item) => item.id));
  for (const token of descriptionTokens) {
    if (plannedIds.has(token.mediaId)) {
      continue;
    }
    if (!getMediaItem(token.mediaId)) {
      throw new Error(
        `Description references media id '${token.mediaId}' but no matching --media was provided and no cached media exists for it.`
      );
    }
  }

  const appendedTokens = mediaItems
    .filter((item) => !tokenById.has(item.id))
    .map((item) =>
      renderCanonicalMediaToken({
        mediaId: item.id,
        kind: item.kind,
        label: item.label,
      })
    );

  return {
    description: appendMediaTokens(options.description, appendedTokens),
    mediaItems,
  };
}

export function cachePreparedDescriptionMedia(
  issueId: string,
  mediaItems: PlannedMediaItem[]
): MediaItem[] {
  return mediaItems.map((mediaItem) =>
    cacheMediaItem({
      ...mediaItem,
      issue_local_id: issueId,
      source: "description",
    })
  );
}
