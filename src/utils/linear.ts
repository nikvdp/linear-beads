/**
 * Linear API operations
 */

import { basename } from "path";
import {
  createLinearPaginationGuard,
  getGraphQLClient,
  ISSUE_FRAGMENT,
  ISSUE_WITH_RELATIONS_FRAGMENT,
} from "./graphql.js";
import {
  getRepoLabel,
  getRepoName,
  getRepoScope,
  getTeamKey,
  useLabelScope,
  useProjectScope,
  useTypes,
} from "./config.js";
import {
  cacheIssue,
  cacheIssues,
  cacheDependency,
  clearIssueDependencies,
  clearIssuesCache,
  deleteDependencyByType,
  deleteRelatedDependency,
  cacheLabel,
  getLabelIdByName,
  cacheProject,
  getProjectIdByName,
  updateLastSync,
  updateLastFullSync,
  pruneStaleIssues,
  cacheViewer,
  cacheMediaItem,
  getCachedViewer,
  generateMediaId,
  getMediaItem,
  getMediaItemByLinearAttachmentId,
  getMediaItemByRemoteUrl,
  ensureIssueSyncKey,
  getIssueSyncKey,
  isValidMediaId,
  getLinearIdentifierForLocalId,
  getSyncedIssueBySyncKey,
  listMediaItemsForIssue,
  resolveIssueLocalId,
} from "./database.js";
import type {
  Issue,
  IssueType,
  Priority,
  LinearIssue,
  IssueStatus,
  MediaItem,
  MediaKind,
} from "../types.js";
import {
  linearStateToStatus,
  linearToPriority,
  labelToIssueType,
  priorityToLinear,
  statusToLinearState,
} from "../types.js";
import { protectDescriptionFromEscapedNewlines } from "./description-input.js";

type RelationType = "blocks" | "related";
type LinearRelationNode = {
  id: string;
  type: string;
  relatedIssue: { id: string };
};
export type GraphqlRequestClient = {
  request<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
};
const SYNC_KEY_MARKER_RE = /<!--\s*lb:sync_key=([a-f0-9-]{8,})\s*-->/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISSUE_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const MARKDOWN_LINK_OR_IMAGE_RE = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g;
const ISSUE_TOKEN_RE = /\b([a-z][a-z0-9]{1,14}-\d+)\b/gi;
const CANONICAL_ISSUE_TOKEN_RE = /^[A-Z][A-Z0-9]{1,14}-\d+$/;
const LB_MEDIA_TARGET_PREFIX = "lb-media:";
const LB_REF_HOST = "lb-ref.invalid";
const LB_REF_PATH = "/issue";
const LINEAR_ISSUE_PATH_RE = /^(?:\/[^/]+)?\/issue\/([a-z][a-z0-9]{1,14}-\d+)(?:\/[^/?#]+)?\/?$/i;
const LINEAR_UPLOAD_HOST = "uploads.linear.app";
const IMAGE_FILE_EXTENSIONS = new Set([
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

export type DescriptionRefRewrite = {
  text: string;
  url: string;
  format?: "markdown" | "url";
};

type MarkdownLinkMatch = {
  full: string;
  text: string;
  url: string;
  index: number;
};

type ProtectedSpan = {
  start: number;
  end: number;
};

type BacktickCodeSpan = ProtectedSpan & {
  markerLength: number;
  inline: boolean;
};

export type LbRefLink = {
  syncKey: string;
  hint?: string;
};

export type CanonicalMediaToken = {
  full: string;
  label: string;
  target: string;
  mediaId: string;
  kind: MediaKind;
  index: number;
};

let workspaceUrlKeyCache: string | null = null;

function stripMarkdownUrlWrapper(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">") && trimmed.length > 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeIssueToken(raw: string): string {
  const [prefix, number] = raw.split("-", 2);
  if (!prefix || !number) return raw;
  const normalizedPrefix = prefix.toUpperCase();
  if (normalizedPrefix === "LOCAL") {
    return `${normalizedPrefix}-${number}`;
  }
  const normalizedNumber = number.replace(/^0+(?=\d)/, "") || "0";
  return `${normalizedPrefix}-${normalizedNumber}`;
}

function collectMarkdownLinks(text: string): MarkdownLinkMatch[] {
  const links: MarkdownLinkMatch[] = [];
  for (const match of text.matchAll(ISSUE_LINK_RE)) {
    if (match.index === undefined) continue;
    links.push({
      full: match[0],
      text: match[1],
      url: match[2],
      index: match.index,
    });
  }
  return links;
}

function collectBacktickCodeSpans(text: string): BacktickCodeSpan[] {
  const spans: BacktickCodeSpan[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "`") {
      continue;
    }

    let tickCount = 1;
    while (text[index + tickCount] === "`") {
      tickCount += 1;
    }

    const marker = "`".repeat(tickCount);
    const closingIndex = text.indexOf(marker, index + tickCount);
    if (closingIndex === -1) {
      index += tickCount - 1;
      continue;
    }

    spans.push({
      start: index,
      end: closingIndex + tickCount,
      markerLength: tickCount,
      inline: tickCount < 3 && !text.slice(index + tickCount, closingIndex).includes("\n"),
    });
    index = closingIndex + tickCount - 1;
  }

  return spans;
}

function collectBacktickSpans(text: string): ProtectedSpan[] {
  return collectBacktickCodeSpans(text).map(({ start, end }) => ({ start, end }));
}

function rewriteIssueTokensOutsideMarkdownLinks(
  text: string,
  rewriteToken: (token: string) => DescriptionRefRewrite | null
): string {
  const spans = collectMarkdownLinks(text)
    .map((link) => ({
      start: link.index,
      end: link.index + link.full.length,
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);

  if (spans.length === 0) {
    return rewriteIssueTokensInChunk(text, rewriteToken);
  }

  let cursor = 0;
  let output = "";
  for (const span of spans) {
    if (span.start > cursor) {
      output += rewriteIssueTokensInChunk(text.slice(cursor, span.start), rewriteToken);
    }
    output += text.slice(span.start, span.end);
    cursor = span.end;
  }

  if (cursor < text.length) {
    output += rewriteIssueTokensInChunk(text.slice(cursor), rewriteToken);
  }

  return output;
}

function rewriteIssueTokensOutsideMarkdownLinksAndFencedCode(
  text: string,
  rewriteToken: (token: string) => DescriptionRefRewrite | null
): string {
  const codeSpans = collectBacktickCodeSpans(text);
  if (codeSpans.length === 0) {
    return rewriteIssueTokensOutsideMarkdownLinks(text, rewriteToken);
  }

  let cursor = 0;
  let output = "";
  for (const span of codeSpans) {
    if (span.start > cursor) {
      output += rewriteIssueTokensOutsideMarkdownLinks(
        text.slice(cursor, span.start),
        rewriteToken
      );
    }

    const fullSpan = text.slice(span.start, span.end);
    if (!span.inline) {
      output += fullSpan;
      cursor = span.end;
      continue;
    }

    const contentStart = span.start + span.markerLength;
    const contentEnd = span.end - span.markerLength;
    const inner = text.slice(contentStart, contentEnd);
    const rewrittenInner = rewriteIssueTokensOutsideMarkdownLinks(inner, rewriteToken);
    output += rewrittenInner === inner ? fullSpan : rewrittenInner;
    cursor = span.end;
  }

  if (cursor < text.length) {
    output += rewriteIssueTokensOutsideMarkdownLinks(text.slice(cursor), rewriteToken);
  }

  return output;
}

function collectProtectedSpans(text: string): ProtectedSpan[] {
  const spans = [
    ...collectMarkdownLinks(text).map((link) => ({
      start: link.index,
      end: link.index + link.full.length,
    })),
    ...collectBacktickSpans(text),
  ].sort((left, right) => left.start - right.start || left.end - right.end);

  if (spans.length === 0) {
    return spans;
  }

  const merged: ProtectedSpan[] = [spans[0]];
  for (const span of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }

  return merged;
}

function formatLinearMentionUrl(url: string): string {
  return `<${url}>`;
}

function rewriteOutsideProtectedSpans(
  text: string,
  rewriteChunk: (chunk: string) => string
): string {
  const spans = collectProtectedSpans(text);
  if (spans.length === 0) {
    return rewriteChunk(text);
  }

  let cursor = 0;
  let output = "";
  for (const span of spans) {
    if (span.start > cursor) {
      const chunk = text.slice(cursor, span.start);
      output += rewriteChunk(chunk);
    }
    output += text.slice(span.start, span.end);
    cursor = span.end;
  }

  if (cursor < text.length) {
    const tail = text.slice(cursor);
    output += rewriteChunk(tail);
  }

  return output;
}

function rewriteIssueLinksOutsideBackticks(
  text: string,
  rewriteLink: (full: string, label: string, url: string) => string
): string {
  const spans = collectBacktickSpans(text);
  const rewriteChunk = (chunk: string): string =>
    chunk.replace(ISSUE_LINK_RE, (full, label: string, url: string) =>
      rewriteLink(full, label, url)
    );

  if (spans.length === 0) {
    return rewriteChunk(text);
  }

  let cursor = 0;
  let output = "";
  for (const span of spans) {
    if (span.start > cursor) {
      output += rewriteChunk(text.slice(cursor, span.start));
    }
    output += text.slice(span.start, span.end);
    cursor = span.end;
  }

  if (cursor < text.length) {
    output += rewriteChunk(text.slice(cursor));
  }

  return output;
}

export function buildLbRefUrl(syncKey: string, hint?: string): string {
  const url = new URL(`https://${LB_REF_HOST}${LB_REF_PATH}`);
  url.searchParams.set("sync_key", syncKey);
  if (hint) {
    url.searchParams.set("hint", hint);
  }
  return url.toString();
}

export function parseLbRefUrl(rawUrl: string): LbRefLink | null {
  let parsed: URL;
  try {
    parsed = new URL(stripMarkdownUrlWrapper(rawUrl));
  } catch {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== LB_REF_HOST || parsed.pathname !== LB_REF_PATH) {
    return null;
  }

  const syncKey = parsed.searchParams.get("sync_key")?.trim();
  if (!syncKey || !isUuid(syncKey)) {
    return null;
  }

  const hint = parsed.searchParams.get("hint")?.trim() || undefined;
  return { syncKey, hint };
}

export function parseLbMediaTarget(rawTarget: string): { mediaId: string } | null {
  const normalized = stripMarkdownUrlWrapper(rawTarget);
  if (!normalized.startsWith(LB_MEDIA_TARGET_PREFIX)) {
    return null;
  }

  const mediaId = normalized.slice(LB_MEDIA_TARGET_PREFIX.length).trim();
  if (!isValidMediaId(mediaId)) {
    return null;
  }

  return { mediaId };
}

export function buildLbMediaTarget(mediaId: string): string {
  if (!isValidMediaId(mediaId)) {
    throw new Error(`Invalid media id '${mediaId}'.`);
  }
  return `${LB_MEDIA_TARGET_PREFIX}${mediaId}`;
}

export function renderCanonicalMediaToken(input: {
  mediaId: string;
  kind: MediaKind;
  label?: string;
}): string {
  const label = input.label || "";
  const target = buildLbMediaTarget(input.mediaId);
  return input.kind === "image" ? `![${label}](${target})` : `[${label}](${target})`;
}

export function collectCanonicalMediaTokens(description: string): CanonicalMediaToken[] {
  const tokens: CanonicalMediaToken[] = [];

  for (const match of description.matchAll(MARKDOWN_LINK_OR_IMAGE_RE)) {
    if (match.index === undefined) continue;
    const parsed = parseLbMediaTarget(match[3]);
    if (!parsed) continue;
    tokens.push({
      full: match[0],
      label: match[2],
      target: match[3],
      mediaId: parsed.mediaId,
      kind: match[1] === "!" ? "image" : "file",
      index: match.index,
    });
  }

  return tokens;
}

export function rewriteCanonicalMediaTokensOutsideBackticks(
  description: string,
  rewriteToken: (token: CanonicalMediaToken) => string
): string {
  const spans = collectBacktickSpans(description);
  const rewriteChunk = (chunk: string, offset: number): string =>
    chunk.replace(
      MARKDOWN_LINK_OR_IMAGE_RE,
      (full, bang: string, label: string, target: string, index: number) => {
        const parsed = parseLbMediaTarget(target);
        if (!parsed) {
          return full;
        }

        return rewriteToken({
          full,
          label,
          target,
          mediaId: parsed.mediaId,
          kind: bang === "!" ? "image" : "file",
          index: offset + index,
        });
      }
    );

  if (spans.length === 0) {
    return rewriteChunk(description, 0);
  }

  let cursor = 0;
  let output = "";
  for (const span of spans) {
    if (span.start > cursor) {
      output += rewriteChunk(description.slice(cursor, span.start), cursor);
    }
    output += description.slice(span.start, span.end);
    cursor = span.end;
  }

  if (cursor < description.length) {
    output += rewriteChunk(description.slice(cursor), cursor);
  }

  return output;
}

async function rewriteCanonicalMediaTokensOutsideBackticksAsync(
  description: string,
  rewriteToken: (token: CanonicalMediaToken) => Promise<string>
): Promise<string> {
  const spans = collectBacktickSpans(description);
  const rewriteChunk = async (chunk: string, offset: number): Promise<string> => {
    const matches = [...chunk.matchAll(MARKDOWN_LINK_OR_IMAGE_RE)];
    if (matches.length === 0) {
      return chunk;
    }

    let cursor = 0;
    let output = "";
    for (const match of matches) {
      const index = match.index ?? 0;
      const full = match[0];
      output += chunk.slice(cursor, index);

      const parsed = parseLbMediaTarget(match[3]);
      if (!parsed) {
        output += full;
      } else {
        output += await rewriteToken({
          full,
          label: match[2],
          target: match[3],
          mediaId: parsed.mediaId,
          kind: match[1] === "!" ? "image" : "file",
          index: offset + index,
        });
      }
      cursor = index + full.length;
    }

    output += chunk.slice(cursor);
    return output;
  };

  if (spans.length === 0) {
    return await rewriteChunk(description, 0);
  }

  let cursor = 0;
  let output = "";
  for (const span of spans) {
    if (span.start > cursor) {
      output += await rewriteChunk(description.slice(cursor, span.start), cursor);
    }
    output += description.slice(span.start, span.end);
    cursor = span.end;
  }

  if (cursor < description.length) {
    output += await rewriteChunk(description.slice(cursor), cursor);
  }

  return output;
}

function rewriteMarkdownLinksAndImagesOutsideBackticks(
  text: string,
  rewriteLink: (full: string, kind: MediaKind, label: string, url: string) => string
): string {
  const spans = collectBacktickSpans(text);
  const rewriteChunk = (chunk: string): string =>
    chunk.replace(MARKDOWN_LINK_OR_IMAGE_RE, (full, bang: string, label: string, url: string) =>
      rewriteLink(full, bang === "!" ? "image" : "file", label, url)
    );

  if (spans.length === 0) {
    return rewriteChunk(text);
  }

  let cursor = 0;
  let output = "";
  for (const span of spans) {
    if (span.start > cursor) {
      output += rewriteChunk(text.slice(cursor, span.start));
    }
    output += text.slice(span.start, span.end);
    cursor = span.end;
  }

  if (cursor < text.length) {
    output += rewriteChunk(text.slice(cursor));
  }

  return output;
}

function filenameExtension(filename: string | undefined): string {
  if (!filename) {
    return "";
  }
  const normalized = filename.trim().toLowerCase();
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === normalized.length - 1) {
    return "";
  }
  return normalized.slice(lastDot);
}

function inferMediaKind(input: {
  label?: string;
  url?: string;
  mimeType?: string;
  fallback?: MediaKind;
}): MediaKind {
  const normalizedMimeType = input.mimeType?.trim().toLowerCase();
  if (normalizedMimeType?.startsWith("image/")) {
    return "image";
  }

  if (
    IMAGE_FILE_EXTENSIONS.has(filenameExtension(input.label)) ||
    IMAGE_FILE_EXTENSIONS.has(filenameExtension(input.url))
  ) {
    return "image";
  }

  return input.fallback || "file";
}

export function getLinearUploadProbeUrl(): string {
  return `https://${LINEAR_UPLOAD_HOST}/`;
}

export function isLinearUploadUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(stripMarkdownUrlWrapper(rawUrl));
    return parsed.hostname.toLowerCase() === LINEAR_UPLOAD_HOST;
  } catch {
    return false;
  }
}

function guessFilenameFromUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(stripMarkdownUrlWrapper(rawUrl));
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.at(-1);
  } catch {
    return undefined;
  }
}

function preferredMediaLabel(item: MediaItem, fallbackLabel?: string): string {
  if (item.label && item.label.trim()) {
    return item.label;
  }
  if (fallbackLabel && fallbackLabel.trim()) {
    return fallbackLabel;
  }
  if (item.original_filename && item.original_filename.trim()) {
    return item.original_filename;
  }
  return item.id;
}

function registerRemoteDescriptionMedia(
  issueId: string | undefined,
  token: { kind: MediaKind; label: string; url: string }
): MediaItem {
  const existing = getMediaItemByRemoteUrl(token.url);
  const mediaId = existing?.id || generateMediaId();
  const issueLocalId = issueId ? resolveIssueLocalId(issueId) : existing?.issue_local_id;
  const next = cacheMediaItem({
    id: mediaId,
    issue_local_id: issueLocalId,
    source: "description",
    kind: existing?.kind || token.kind,
    label: existing?.label || token.label || undefined,
    original_filename:
      existing?.original_filename || token.label || guessFilenameFromUrl(token.url) || undefined,
    mime_type: existing?.mime_type,
    byte_size: existing?.byte_size,
    local_path: existing?.local_path,
    remote_url: token.url,
    attachment_id: existing?.attachment_id,
  });
  return next;
}

function registerIssueAttachments(issueId: string, issue: LinearIssue): void {
  const issueLocalId = resolveIssueLocalId(issueId);
  const attachments = issue.attachments?.nodes || [];
  for (const attachment of attachments) {
    const existing =
      getMediaItemByLinearAttachmentId(attachment.id) || getMediaItemByRemoteUrl(attachment.url);
    const metadata = attachment.metadata || {};
    const mimeType =
      typeof metadata.mimetype === "string"
        ? metadata.mimetype
        : typeof metadata.mimeType === "string"
          ? metadata.mimeType
          : existing?.mime_type;
    cacheMediaItem({
      id: existing?.id || generateMediaId(),
      issue_local_id: issueLocalId,
      source: "attachment",
      kind: existing?.kind || inferMediaKind({ label: attachment.title, mimeType }),
      label: existing?.label || attachment.title || undefined,
      original_filename:
        existing?.original_filename ||
        attachment.title ||
        guessFilenameFromUrl(attachment.url) ||
        undefined,
      mime_type: mimeType,
      byte_size:
        typeof metadata.size === "number"
          ? metadata.size
          : typeof metadata.fileSize === "number"
            ? metadata.fileSize
            : existing?.byte_size,
      local_path: existing?.local_path,
      remote_url: attachment.url,
      attachment_id: attachment.id,
    });
  }
}

async function ensureLinearMediaRemoteUrl(
  mediaId: string,
  client: GraphqlRequestClient
): Promise<MediaItem> {
  const item = getMediaItem(mediaId);
  if (!item) {
    throw new Error(`Unknown media id '${mediaId}'.`);
  }
  if (item.remote_url) {
    return item;
  }
  if (!item.local_path) {
    throw new Error(`Media '${mediaId}' has no local file path and no remote URL.`);
  }

  const file = Bun.file(item.local_path);
  if (!(await file.exists())) {
    throw new Error(`Media file not found: ${item.local_path}`);
  }

  const filename = item.original_filename || basename(item.local_path);
  const contentType = item.mime_type || file.type || "application/octet-stream";
  const size = item.byte_size ?? file.size;

  const mutation = `
    mutation FileUpload($filename: String!, $contentType: String!, $size: Int!) {
      fileUpload(filename: $filename, contentType: $contentType, size: $size) {
        uploadFile {
          uploadUrl
          assetUrl
          headers {
            key
            value
          }
          filename
          contentType
          size
        }
      }
    }
  `;

  const result = await client.request<{
    fileUpload?: {
      uploadFile?: {
        uploadUrl: string;
        assetUrl: string;
        headers?: Array<{ key: string; value: string }> | Record<string, string> | null;
        filename?: string | null;
        contentType?: string | null;
        size?: number | null;
      } | null;
    } | null;
  }>(mutation, {
    filename,
    contentType,
    size,
  });

  const uploadFile = result.fileUpload?.uploadFile;
  if (!uploadFile?.uploadUrl || !uploadFile.assetUrl) {
    throw new Error(`Linear file upload failed for media '${mediaId}'.`);
  }

  const headers = new Headers();
  if (Array.isArray(uploadFile.headers)) {
    for (const header of uploadFile.headers) {
      headers.set(header.key, header.value);
    }
  } else {
    for (const [key, value] of Object.entries(uploadFile.headers || {})) {
      headers.set(key, value);
    }
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", contentType);
  }

  const uploadResponse = await fetch(uploadFile.uploadUrl, {
    method: "PUT",
    headers,
    body: file,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Linear media upload network error for '${mediaId}' (endpointName=uploads, host=${LINEAR_UPLOAD_HOST}): ${message}`
    );
  });
  if (!uploadResponse.ok) {
    throw new Error(
      `Linear media upload PUT failed for '${mediaId}' with ${uploadResponse.status}.`
    );
  }

  return cacheMediaItem({
    id: item.id,
    issue_local_id: item.issue_local_id,
    source: item.source,
    kind: item.kind,
    label: item.label,
    original_filename: filename,
    mime_type: uploadFile.contentType || contentType,
    byte_size: uploadFile.size ?? size,
    local_path: item.local_path,
    remote_url: uploadFile.assetUrl,
    attachment_id: item.attachment_id,
  });
}

async function encodeCanonicalMediaTokensInDescription(
  description: string | undefined,
  client: GraphqlRequestClient
): Promise<string | undefined> {
  if (description === undefined) {
    return undefined;
  }

  return await rewriteCanonicalMediaTokensOutsideBackticksAsync(description, async (token) => {
    const item = await ensureLinearMediaRemoteUrl(token.mediaId, client);
    const label = preferredMediaLabel(item, token.label);
    return item.kind === "image"
      ? `![${label}](${item.remote_url})`
      : `[${label}](${item.remote_url})`;
  });
}

export function renderDescriptionWithCanonicalMedia(
  description: string | undefined,
  issueId?: string
): string | undefined {
  if (description === undefined) {
    return undefined;
  }

  const rendered = rewriteMarkdownLinksAndImagesOutsideBackticks(
    description,
    (full, kind, label, url) => {
      if (!isLinearUploadUrl(url)) {
        return full;
      }

      const item = registerRemoteDescriptionMedia(issueId, { kind, label, url });
      return renderCanonicalMediaToken({
        mediaId: item.id,
        kind: item.kind,
        label: preferredMediaLabel(item, label),
      });
    }
  );

  if (!issueId) {
    return rendered;
  }

  const renderedMediaIds = new Set<string>();
  rewriteCanonicalMediaTokensOutsideBackticks(rendered, (token) => {
    renderedMediaIds.add(token.mediaId);
    return token.full;
  });

  const allMedia = listMediaItemsForIssue(issueId);
  const descriptionUrls = new Set(
    allMedia
      .filter((item) => item.source === "description" && item.remote_url)
      .map((item) => item.remote_url as string)
  );
  const detachedTokens = allMedia
    .filter((item) => item.source === "attachment")
    .filter((item) => !renderedMediaIds.has(item.id))
    .filter((item) => !item.remote_url || !descriptionUrls.has(item.remote_url))
    .map((item) =>
      renderCanonicalMediaToken({
        mediaId: item.id,
        kind: item.kind,
        label: preferredMediaLabel(item),
      })
    );

  if (detachedTokens.length === 0) {
    return rendered;
  }

  if (!rendered || rendered.trim() === "") {
    return detachedTokens.join("\n\n");
  }

  return `${rendered.replace(/\s+$/, "")}\n\n${detachedTokens.join("\n\n")}`;
}

type LinearIssueUrlMatch = {
  identifier: string;
  cleanUrl: string;
  cleanPathname: string;
  trailingPunctuation: string;
};

function parseLinearIssueUrl(rawUrl: string): LinearIssueUrlMatch | null {
  let parsed: URL;
  try {
    parsed = new URL(stripMarkdownUrlWrapper(rawUrl));
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "linear.app" && !host.endsWith(".linear.app")) {
    return null;
  }

  const trailingPunctuationMatch = parsed.pathname.match(/([:;,.!?]+)$/);
  const trailingPunctuation = trailingPunctuationMatch?.[1] || "";
  const cleanPathname = trailingPunctuation
    ? parsed.pathname.slice(0, -trailingPunctuation.length)
    : parsed.pathname;
  const match = cleanPathname.match(LINEAR_ISSUE_PATH_RE);
  if (!match) {
    return null;
  }

  parsed.pathname = cleanPathname;
  return {
    identifier: normalizeIssueToken(match[1]),
    cleanUrl: parsed.toString(),
    cleanPathname,
    trailingPunctuation,
  };
}

export function extractIssueIdentifierFromLinearUrl(rawUrl: string): string | null {
  return parseLinearIssueUrl(rawUrl)?.identifier || null;
}

function extractLinearIssueUrlTrailingPunctuation(rawUrl: string): string {
  return parseLinearIssueUrl(rawUrl)?.trailingPunctuation || "";
}

function issueIdentifierToLinearUrl(identifier: string, workspaceUrlKey: string): string {
  return `https://linear.app/${workspaceUrlKey}/issue/${normalizeIssueToken(identifier)}`;
}

function issueIdentifierToGenericLinearUrl(identifier: string): string {
  return `https://linear.app/issue/${normalizeIssueToken(identifier)}`;
}

function isGenericLinearIssueUrl(rawUrl: string): boolean {
  const match = parseLinearIssueUrl(rawUrl);
  if (!match) {
    return false;
  }
  return /^\/issue\/[a-z][a-z0-9]{1,14}-\d+(?:\/[^/?#]+)?\/?$/i.test(match.cleanPathname);
}

function isRawLinearUrlLabel(label: string, linearIdentifier: string): boolean {
  return extractIssueIdentifierFromLinearUrl(label) === linearIdentifier;
}

function shouldNormalizeLinearMarkdownLink(label: string, linearIdentifier: string): boolean {
  const normalizedLabel = normalizeIssueToken(label);
  if (normalizedLabel.startsWith("LOCAL-")) {
    return true;
  }
  return normalizedLabel === linearIdentifier || isRawLinearUrlLabel(label, linearIdentifier);
}

type TrackedIssueRef = {
  localId: string;
  syncKey: string | null;
  linearIdentifier: string | null;
};

function resolveTrackedIssueRef(token: string): TrackedIssueRef | null {
  const normalized = normalizeIssueToken(token);
  const localId = resolveIssueLocalId(normalized);
  const linearIdentifier = getLinearIdentifierForLocalId(localId);
  const syncKey = getIssueSyncKey(localId);
  if (!syncKey && !linearIdentifier) {
    return null;
  }

  return {
    localId,
    syncKey,
    linearIdentifier,
  };
}

async function getWorkspaceUrlKey(
  client: GraphqlRequestClient = getGraphQLClient() as unknown as GraphqlRequestClient
): Promise<string | null> {
  if (workspaceUrlKeyCache) {
    return workspaceUrlKeyCache;
  }

  const query = `
    query GetWorkspaceUrlKey {
      viewer {
        url
        organization {
          urlKey
        }
      }
    }
  `;

  try {
    const result = await client.request<{
      viewer: { url?: string | null; organization?: { urlKey?: string | null } | null };
    }>(query);

    const orgKey = result.viewer.organization?.urlKey?.trim();
    if (orgKey) {
      workspaceUrlKeyCache = orgKey;
      return workspaceUrlKeyCache;
    }

    const viewerUrl = result.viewer.url?.trim();
    if (!viewerUrl) return null;
    const parsed = new URL(viewerUrl);
    const slug = parsed.pathname.split("/").filter(Boolean)[0]?.trim();
    if (!slug) return null;
    workspaceUrlKeyCache = slug;
    return workspaceUrlKeyCache;
  } catch {
    return null;
  }
}

async function rewriteIssueTokenForLinearDescription(
  token: string,
  workspaceUrlKey: string | null
): Promise<DescriptionRefRewrite | null> {
  const normalized = normalizeIssueToken(token);
  const trackedRef = resolveTrackedIssueRef(normalized);
  if (trackedRef) {
    if (trackedRef.linearIdentifier) {
      return {
        text: normalized,
        url: workspaceUrlKey
          ? issueIdentifierToLinearUrl(trackedRef.linearIdentifier, workspaceUrlKey)
          : issueIdentifierToGenericLinearUrl(trackedRef.linearIdentifier),
        format: "url",
      };
    }
    if (!trackedRef.syncKey) {
      return null;
    }
    return {
      text: normalized,
      url: buildLbRefUrl(trackedRef.syncKey, normalized),
    };
  }

  if (!normalized.startsWith("LOCAL-") && CANONICAL_ISSUE_TOKEN_RE.test(normalized)) {
    return {
      text: normalized,
      url: workspaceUrlKey
        ? issueIdentifierToLinearUrl(normalized, workspaceUrlKey)
        : issueIdentifierToGenericLinearUrl(normalized),
      format: "url",
    };
  }

  return null;
}

function upgradeDescriptionIssueLinksToLinearUrls(
  description: string,
  workspaceUrlKey: string | null
): string {
  return rewriteIssueLinksOutsideBackticks(description, (full, label: string, url: string) => {
    const ref = parseLbRefUrl(url);
    if (ref) {
      const synced = getSyncedIssueBySyncKey(ref.syncKey);
      if (!synced?.linear_identifier) {
        return full;
      }
      const resolvedUrl = workspaceUrlKey
        ? issueIdentifierToLinearUrl(synced.linear_identifier, workspaceUrlKey)
        : issueIdentifierToGenericLinearUrl(synced.linear_identifier);
      return formatLinearMentionUrl(resolvedUrl);
    }

    const linearUrl = parseLinearIssueUrl(url);
    if (!linearUrl) {
      return full;
    }

    const normalizedLabel = normalizeIssueToken(label);
    const isCanonicalWorkspaceLink =
      !linearUrl.trailingPunctuation &&
      !isGenericLinearIssueUrl(url) &&
      normalizedLabel === linearUrl.identifier;
    if (isCanonicalWorkspaceLink) {
      return full;
    }

    if (!shouldNormalizeLinearMarkdownLink(label, linearUrl.identifier)) {
      return full;
    }

    if (isGenericLinearIssueUrl(url) && !workspaceUrlKey && !linearUrl.trailingPunctuation) {
      return full;
    }

    const normalizedUrl = workspaceUrlKey
      ? issueIdentifierToLinearUrl(linearUrl.identifier, workspaceUrlKey)
      : linearUrl.cleanUrl;
    return `${formatLinearMentionUrl(normalizedUrl)}${linearUrl.trailingPunctuation}`;
  });
}

function rewriteIssueTokensInChunk(
  chunk: string,
  rewriteToken: (token: string) => DescriptionRefRewrite | null
): string {
  return chunk.replace(
    ISSUE_TOKEN_RE,
    (full, _token: string, offset: number, source: string): string => {
      const prevChar = offset > 0 ? source[offset - 1] : "";
      if (prevChar === "/" || prevChar === ":") {
        return full;
      }

      const rewrite = rewriteToken(full);
      if (!rewrite) return full;
      if (rewrite.format === "url") {
        return formatLinearMentionUrl(rewrite.url);
      }
      return `[${rewrite.text}](${rewrite.url})`;
    }
  );
}

export function toCanonicalLocalDescription(
  description: string | undefined,
  options: { autoFormatEscapedNewlines?: boolean } = {}
): string | undefined {
  const normalizedDescription = protectDescriptionFromEscapedNewlines(description, {
    autoFormat: options.autoFormatEscapedNewlines,
  }).description;

  if (normalizedDescription === undefined) {
    return undefined;
  }

  return rewriteIssueTokensOutsideMarkdownLinksAndFencedCode(normalizedDescription, (token) => {
    const normalized = normalizeIssueToken(token);
    const trackedRef = resolveTrackedIssueRef(normalized);
    if (!trackedRef) {
      return null;
    }

    const syncKey = trackedRef.syncKey || ensureIssueSyncKey(trackedRef.localId);

    return {
      text: normalized,
      url: buildLbRefUrl(syncKey, normalized),
    };
  });
}

export async function toLinearRichDescription(
  description: string | undefined,
  options: {
    client?: GraphqlRequestClient;
    workspaceUrlKey?: string | null;
    autoFormatEscapedNewlines?: boolean;
  } = {}
): Promise<string | undefined> {
  if (description === undefined) {
    return undefined;
  }
  const canonicalLocalDescription = toCanonicalLocalDescription(description, {
    autoFormatEscapedNewlines: options.autoFormatEscapedNewlines,
  });
  const client = options.client || (getGraphQLClient() as unknown as GraphqlRequestClient);
  const mediaExpandedDescription = await encodeCanonicalMediaTokensInDescription(
    canonicalLocalDescription,
    client
  );
  const workspaceUrlKey =
    options.workspaceUrlKey !== undefined
      ? options.workspaceUrlKey
      : await getWorkspaceUrlKey(client);

  const encoded = await encodeIssueRefsInDescription(mediaExpandedDescription, (token) =>
    rewriteIssueTokenForLinearDescription(token, workspaceUrlKey)
  );
  if (encoded === undefined) {
    return undefined;
  }
  return upgradeDescriptionIssueLinksToLinearUrls(encoded, workspaceUrlKey);
}

export async function encodeIssueRefsInDescription(
  description: string | undefined,
  rewriteToken: (
    token: string
  ) => Promise<DescriptionRefRewrite | null> | DescriptionRefRewrite | null
): Promise<string | undefined> {
  if (description === undefined) return undefined;
  const rewriteOutsideMarkdownLinks = async (text: string): Promise<string> => {
    const rewriteChunk = async (chunk: string): Promise<string> => {
      const matches = [...chunk.matchAll(ISSUE_TOKEN_RE)];
      if (matches.length === 0) return chunk;

      let cursor = 0;
      let output = "";
      for (const match of matches) {
        const index = match.index ?? 0;
        const full = match[0];
        output += chunk.slice(cursor, index);

        const prevChar = index > 0 ? chunk[index - 1] : "";
        if (prevChar === "/" || prevChar === ":") {
          output += full;
        } else {
          const rewrite = await rewriteToken(normalizeIssueToken(full));
          if (!rewrite) {
            output += full;
          } else if (rewrite.format === "url") {
            output += formatLinearMentionUrl(rewrite.url);
          } else {
            output += `[${rewrite.text}](${rewrite.url})`;
          }
        }
        cursor = index + full.length;
      }
      output += chunk.slice(cursor);
      return output;
    };

    const spans = collectMarkdownLinks(text)
      .map((link) => ({
        start: link.index,
        end: link.index + link.full.length,
      }))
      .sort((left, right) => left.start - right.start || left.end - right.end);

    if (spans.length === 0) {
      return await rewriteChunk(text);
    }

    let cursor = 0;
    let output = "";
    for (const span of spans) {
      if (span.start > cursor) {
        output += await rewriteChunk(text.slice(cursor, span.start));
      }
      output += text.slice(span.start, span.end);
      cursor = span.end;
    }

    if (cursor < text.length) {
      output += await rewriteChunk(text.slice(cursor));
    }

    return output;
  };

  const codeSpans = collectBacktickCodeSpans(description);
  if (codeSpans.length === 0) {
    return await rewriteOutsideMarkdownLinks(description);
  }

  let cursor = 0;
  let output = "";
  for (const span of codeSpans) {
    if (span.start > cursor) {
      output += await rewriteOutsideMarkdownLinks(description.slice(cursor, span.start));
    }

    const fullSpan = description.slice(span.start, span.end);
    if (!span.inline) {
      output += fullSpan;
      cursor = span.end;
      continue;
    }

    const contentStart = span.start + span.markerLength;
    const contentEnd = span.end - span.markerLength;
    const inner = description.slice(contentStart, contentEnd);
    const rewrittenInner = await rewriteOutsideMarkdownLinks(inner);
    output += rewrittenInner === inner ? fullSpan : rewrittenInner;
    cursor = span.end;
  }

  if (cursor < description.length) {
    output += await rewriteOutsideMarkdownLinks(description.slice(cursor));
  }

  return output;
}

export function upgradeLbRefLinks(
  description: string | undefined,
  resolveSyncKeyToUrl: (ref: LbRefLink, label: string) => string | null
): string | undefined {
  if (description === undefined) return undefined;

  return description.replace(ISSUE_LINK_RE, (full, label: string, url: string) => {
    const ref = parseLbRefUrl(url);
    if (!ref) return full;
    const nextUrl = resolveSyncKeyToUrl(ref, label);
    if (!nextUrl) return full;
    return `[${label}](${nextUrl})`;
  });
}

export function renderIssueLinksAsPlainText(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;

  return rewriteIssueLinksOutsideBackticks(description, (full, label: string, url: string) => {
    const ref = parseLbRefUrl(url);
    if (ref) {
      const synced = getSyncedIssueBySyncKey(ref.syncKey);
      if (synced?.linear_identifier) {
        return synced.linear_identifier;
      }
      return normalizeIssueToken(label);
    }

    const linearIdentifier = extractIssueIdentifierFromLinearUrl(url);
    if (linearIdentifier) {
      const normalizedLabel = normalizeIssueToken(label);
      const trailingPunctuation = extractLinearIssueUrlTrailingPunctuation(url);
      if (normalizedLabel.startsWith("LOCAL-")) {
        return `${linearIdentifier}${trailingPunctuation}`;
      }
      if (CANONICAL_ISSUE_TOKEN_RE.test(normalizedLabel)) {
        return `${normalizedLabel}${trailingPunctuation}`;
      }
      return `${linearIdentifier}${trailingPunctuation}`;
    }

    return full;
  });
}

function splitDescriptionAndSyncKey(description?: string | null): {
  description?: string;
  syncKey?: string;
} {
  if (!description) {
    return {};
  }

  const match = description.match(SYNC_KEY_MARKER_RE);
  if (!match) {
    return { description };
  }

  const syncKey = match[1];
  const withoutMarker = description.replace(SYNC_KEY_MARKER_RE, "").trimEnd();
  return {
    description: withoutMarker || undefined,
    syncKey,
  };
}

function isUuid(value: string | undefined): value is string {
  if (!value) return false;
  return UUID_RE.test(value.trim());
}

/**
 * Convert Linear issue to bd-compatible issue
 */
function linearToBdIssue(
  linear: LinearIssue
): Issue & { linear_state_id: string; sync_key?: string } {
  const labels = linear.labels.nodes.map((l) => l.name);
  const issueType = useTypes() ? labelToIssueType(labels) : undefined;
  const parsedDescription = splitDescriptionAndSyncKey(linear.description);
  const renderedDescription = renderDescriptionWithCanonicalMedia(
    parsedDescription.description,
    linear.identifier
  );

  const issue: Issue & { linear_state_id: string; sync_key?: string } = {
    id: linear.identifier,
    linear_id: linear.id,
    linear_identifier: linear.identifier,
    title: linear.title,
    description: renderedDescription,
    status: linearStateToStatus(linear.state.type),
    priority: linearToPriority(linear.priority),
    created_at: linear.createdAt,
    updated_at: linear.updatedAt,
    closed_at: linear.completedAt || linear.canceledAt || undefined,
    assignee: linear.assignee?.email || undefined,
    linear_state_id: linear.state.id,
  };

  if (issueType) {
    issue.issue_type = issueType;
  }
  if (parsedDescription.syncKey) {
    issue.sync_key = parsedDescription.syncKey;
  }

  return issue;
}

/**
 * Get or create repo label
 */
async function fetchTeamLabels(
  client: GraphqlRequestClient,
  teamId: string
): Promise<Array<{ id: string; name: string }>> {
  const labels: Array<{ id: string; name: string }> = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  const paginationGuard = createLinearPaginationGuard("fetchTeamLabels");

  while (hasNextPage) {
    const requestCursor = cursor;
    const query = `
      query GetLabelsPage($teamId: String!, $cursor: String) {
        team(id: $teamId) {
          labels(first: 50, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              name
            }
          }
        }
      }
    `;

    const result: {
      team: {
        labels: {
          nodes: Array<{ id: string; name: string }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    } = await client.request(query, { teamId, cursor });

    labels.push(...result.team.labels.nodes);
    hasNextPage = result.team.labels.pageInfo.hasNextPage;
    cursor = paginationGuard.nextCursor(result.team.labels.pageInfo, requestCursor);
  }

  return labels;
}

function isDuplicateLabelNameError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("duplicate label name") || msg.includes("already exists");
}

export async function ensureRepoLabel(
  teamId: string,
  options: { client?: GraphqlRequestClient; repoLabel?: string; forceRefresh?: boolean } = {}
): Promise<string> {
  const client: GraphqlRequestClient =
    options.client || (getGraphQLClient() as unknown as GraphqlRequestClient);
  const repoLabel = options.repoLabel || getRepoLabel();
  const forceRefresh = options.forceRefresh === true;

  // Check cache first
  const cachedId = forceRefresh ? null : getLabelIdByName(repoLabel, teamId);
  if (cachedId) return cachedId;

  const existingLabels = await fetchTeamLabels(client, teamId);
  const existing = existingLabels.find((l) => l.name === repoLabel);
  if (existing) {
    cacheLabel(existing.id, existing.name, teamId);
    return existing.id;
  }

  // Create label
  const createMutation = `
    mutation CreateLabel($input: IssueLabelCreateInput!) {
      issueLabelCreate(input: $input) {
        success
        issueLabel {
          id
          name
        }
      }
    }
  `;

  let createResult:
    | {
        issueLabelCreate: {
          success: boolean;
          issueLabel: { id: string; name: string };
        };
      }
    | undefined;

  try {
    createResult = await client.request<{
      issueLabelCreate: {
        success: boolean;
        issueLabel: { id: string; name: string };
      };
    }>(createMutation, {
      input: {
        name: repoLabel,
        teamId,
      },
    });
  } catch (error) {
    if (!isDuplicateLabelNameError(error)) {
      throw error;
    }
  }

  if (!createResult || !createResult.issueLabelCreate.success) {
    const labelsAfterCreate = await fetchTeamLabels(client, teamId);
    const existingAfterCreate = labelsAfterCreate.find((label) => label.name === repoLabel);
    if (existingAfterCreate) {
      cacheLabel(existingAfterCreate.id, existingAfterCreate.name, teamId);
      return existingAfterCreate.id;
    }
  }

  if (!createResult || !createResult.issueLabelCreate.success) {
    throw new Error(`Failed to create repo label: ${repoLabel}`);
  }

  cacheLabel(
    createResult.issueLabelCreate.issueLabel.id,
    createResult.issueLabelCreate.issueLabel.name,
    teamId
  );

  return createResult.issueLabelCreate.issueLabel.id;
}

/**
 * Get or create repo project (for project-based scoping)
 */
export async function ensureRepoProject(
  teamId: string,
  options: { forceRefresh?: boolean } = {}
): Promise<string> {
  const client = getGraphQLClient();
  const projectName = getRepoName() || "unknown";
  const forceRefresh = options.forceRefresh === true;

  // Check cache first
  const cachedId = forceRefresh ? null : getProjectIdByName(projectName, teamId);
  if (cachedId) return cachedId;

  // Query existing projects by name and matching team.
  const query = `
    query GetProjects($name: String!) {
      projects(filter: { name: { eq: $name } }, first: 10) {
        nodes {
          id
          name
          teams {
            nodes {
              id
            }
          }
        }
      }
    }
  `;

  const result = await client.request<{
    projects: {
      nodes: Array<{ id: string; name: string; teams?: { nodes: Array<{ id: string }> } | null }>;
    };
  }>(query, { name: projectName });

  const existing = result.projects.nodes.find(
    (p) => p.name === projectName && p.teams?.nodes.some((team) => team.id === teamId)
  );
  if (existing) {
    cacheProject(existing.id, existing.name, teamId);
    return existing.id;
  }

  // Create project
  const createMutation = `
    mutation CreateProject($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        success
        project {
          id
          name
        }
      }
    }
  `;

  const createResult = await client.request<{
    projectCreate: {
      success: boolean;
      project: { id: string; name: string };
    };
  }>(createMutation, {
    input: {
      name: projectName,
      teamIds: [teamId],
    },
  });

  if (!createResult.projectCreate.success) {
    throw new Error(`Failed to create repo project: ${projectName}`);
  }

  cacheProject(
    createResult.projectCreate.project.id,
    createResult.projectCreate.project.name,
    teamId
  );

  return createResult.projectCreate.project.id;
}

/**
 * Ensure issue type label exists in label group
 * Uses Linear label groups for proper categorization
 */
export async function ensureTypeLabel(
  teamId: string,
  type: IssueType,
  options: { forceRefresh?: boolean } = {}
): Promise<string> {
  const client = getGraphQLClient();
  const groupName = "Type";
  // Label names are capitalized (e.g., "Bug", "Feature")
  const labelName = type.charAt(0).toUpperCase() + type.slice(1);
  const forceRefresh = options.forceRefresh === true;

  // Check cache first
  const cachedId = forceRefresh ? null : getLabelIdByName(labelName, teamId);
  if (cachedId) return cachedId;

  // Query existing labels and label groups
  const query = `
    query GetLabelsAndGroups($teamId: String!) {
      team(id: $teamId) {
        labels {
          nodes {
            id
            name
            parent {
              id
              name
            }
          }
        }
      }
    }
  `;

  const result = await client.request<{
    team: {
      labels: {
        nodes: Array<{
          id: string;
          name: string;
          parent?: { id: string; name: string } | null;
        }>;
      };
    };
  }>(query, { teamId });

  // Look for existing label in the Type group (or matching name)
  const existing = result.team.labels.nodes.find(
    (l) =>
      l.name.toLowerCase() === labelName.toLowerCase() &&
      (l.parent?.name === groupName || !l.parent)
  );
  if (existing) {
    cacheLabel(existing.id, existing.name, teamId);
    return existing.id;
  }

  // Find or create the label group
  let groupId: string | undefined;
  const existingGroup = result.team.labels.nodes.find((l) => l.parent?.name === groupName)?.parent;

  if (existingGroup) {
    groupId = existingGroup.id;
  } else {
    // Create the label group
    const createGroupMutation = `
      mutation CreateLabelGroup($teamId: String!, $name: String!) {
        issueLabelCreate(input: { name: $name, teamId: $teamId }) {
          success
          issueLabel {
            id
            name
          }
        }
      }
    `;

    const groupResult = await client.request<{
      issueLabelCreate: {
        success: boolean;
        issueLabel: { id: string; name: string };
      };
    }>(createGroupMutation, { teamId, name: groupName });

    if (groupResult.issueLabelCreate.success) {
      groupId = groupResult.issueLabelCreate.issueLabel.id;
    }
  }

  // Create the type label (under group if we have one)
  const createMutation = `
    mutation CreateLabel($input: IssueLabelCreateInput!) {
      issueLabelCreate(input: $input) {
        success
        issueLabel {
          id
          name
        }
      }
    }
  `;

  const input: Record<string, unknown> = {
    name: labelName,
    teamId,
  };
  if (groupId) {
    input.parentId = groupId;
  }

  const createResult = await client.request<{
    issueLabelCreate: {
      success: boolean;
      issueLabel: { id: string; name: string };
    };
  }>(createMutation, { input });

  if (!createResult.issueLabelCreate.success) {
    throw new Error(`Failed to create type label: ${labelName}`);
  }

  cacheLabel(
    createResult.issueLabelCreate.issueLabel.id,
    createResult.issueLabelCreate.issueLabel.name,
    teamId
  );

  return createResult.issueLabelCreate.issueLabel.id;
}

/**
 * Get team ID from team key, or auto-detect if not provided
 */
export async function getTeamId(teamKey?: string): Promise<string> {
  const client = getGraphQLClient();
  const key = teamKey || getTeamKey();

  // If team key is provided, look it up
  if (key) {
    const query = `
      query GetTeam($key: String!) {
        teams(filter: { key: { eq: $key } }) {
          nodes {
            id
            key
            name
          }
        }
      }
    `;

    const result = await client.request<{
      teams: { nodes: Array<{ id: string; key: string; name: string }> };
    }>(query, { key });

    if (result.teams.nodes.length === 0) {
      throw new Error(`Team not found: ${key}`);
    }

    return result.teams.nodes[0].id;
  }

  // No team key provided - auto-detect from user's teams
  const query = `
    query GetTeams {
      teams {
        nodes {
          id
          key
          name
        }
      }
    }
  `;

  const result = await client.request<{
    teams: { nodes: Array<{ id: string; key: string; name: string }> };
  }>(query);

  if (result.teams.nodes.length === 0) {
    throw new Error("No teams found for this Linear account.");
  }

  if (result.teams.nodes.length === 1) {
    // Auto-select single team
    const team = result.teams.nodes[0];
    return team.id;
  }

  // Multiple teams - ask user to specify
  const teamList = result.teams.nodes.map((t) => `  - ${t.name} (${t.key})`).join("\n");
  throw new Error(`Multiple teams found. Please set LB_TEAM_KEY or use --team flag:\n${teamList}`);
}

/**
 * Get workflow state ID for a status
 */
export async function getWorkflowStateId(
  teamId: string,
  status: Issue["status"],
  options: { client?: GraphqlRequestClient } = {}
): Promise<string> {
  const client: GraphqlRequestClient =
    options.client || (getGraphQLClient() as unknown as GraphqlRequestClient);
  const stateType = statusToLinearState(status);

  const query = `
    query GetWorkflowStates($teamId: String!) {
      team(id: $teamId) {
        states {
          nodes {
            id
            name
            type
          }
        }
      }
    }
  `;

  const result = await client.request<{
    team: { states: { nodes: Array<{ id: string; name: string; type: string }> } };
  }>(query, { teamId });

  const state = result.team.states.nodes.find((s) => s.type === stateType);
  if (!state) {
    throw new Error(`Workflow state not found for type: ${stateType}`);
  }

  return state.id;
}

/**
 * Fetch issues from Linear with repo scoping
 * Uses a simplified query to avoid Linear API complexity limits
 * Supports label, project, or both scoping modes
 */
export async function fetchIssues(teamId: string): Promise<Issue[]> {
  const client = getGraphQLClient();
  const scope = getRepoScope();

  // Build filter based on scoping mode
  let filter: string;
  let variables: Record<string, string> = { teamId };

  if (scope === "project") {
    // Project-only mode: filter by project name
    const projectName = getRepoName() || "unknown";
    filter = `filter: { project: { name: { eq: $projectName } } }`;
    variables.projectName = projectName;
  } else if (scope === "both") {
    // Both mode: filter by label OR project (use 'or' combinator)
    const repoLabel = getRepoLabel();
    const projectName = getRepoName() || "unknown";
    filter = `filter: { or: [{ labels: { name: { eq: $labelName } } }, { project: { name: { eq: $projectName } } }] }`;
    variables.labelName = repoLabel;
    variables.projectName = projectName;
  } else {
    // Label mode (default): filter by label
    const repoLabel = getRepoLabel();
    filter = `filter: { labels: { name: { eq: $labelName } } }`;
    variables.labelName = repoLabel;
  }

  // Build variable declarations for GraphQL
  const varDecls = Object.keys(variables)
    .map((k) => `$${k}: String!`)
    .join(", ");

  // Use simpler query without nested children/relations to avoid complexity limits
  const query = `
    query GetIssues(${varDecls}) {
      team(id: $teamId) {
        issues(${filter}, first: 100) {
          nodes {
            ${ISSUE_FRAGMENT}
          }
        }
      }
    }
  `;

  const result = await client.request<{
    team: { issues: { nodes: LinearIssue[] } };
  }>(query, variables);

  const issues = result.team.issues.nodes.map(linearToBdIssue);

  // Clear old issues before caching fresh ones (prevents stale issues from other repos)
  clearIssuesCache();

  // Cache issues
  cacheIssues(issues);

  // Cache parent-child relations from the basic query
  for (const linear of result.team.issues.nodes) {
    if (linear.parent) {
      cacheDependency({
        issue_id: linear.identifier,
        depends_on_id: linear.parent.identifier,
        type: "parent-child",
        created_at: linear.createdAt,
        created_by: "sync",
      });
    }
  }

  // Note: We don't fetch relations on bulk sync (too slow - O(n) network calls).
  // Relations are fetched on-demand via `lb show <id> --sync`.
  // This means `lb ready` may show blocked issues until their blockers are synced individually.

  updateLastSync();
  return issues;
}

/**
 * Fetch all issues with pagination (full sync).
 * Clears stale issues after fetching all pages.
 * @returns Object with issues array and pruned count
 */
export async function fetchAllIssuesPaginated(
  teamId: string
): Promise<{ issues: Issue[]; pruned: number }> {
  const client = getGraphQLClient();
  const scope = getRepoScope();

  // Build scope filter based on mode
  let scopeFilter: string;
  let baseVariables: Record<string, string | undefined> = { teamId };

  if (scope === "project") {
    const projectName = getRepoName() || "unknown";
    scopeFilter = `filter: { project: { name: { eq: $projectName } } }`;
    baseVariables.projectName = projectName;
  } else if (scope === "both") {
    const repoLabel = getRepoLabel();
    const projectName = getRepoName() || "unknown";
    scopeFilter = `filter: { or: [{ labels: { name: { eq: $labelName } } }, { project: { name: { eq: $projectName } } }] }`;
    baseVariables.labelName = repoLabel;
    baseVariables.projectName = projectName;
  } else {
    const repoLabel = getRepoLabel();
    scopeFilter = `filter: { labels: { name: { eq: $labelName } } }`;
    baseVariables.labelName = repoLabel;
  }

  const allIssues: Issue[] = [];
  const allIssueIds = new Set<string>();
  let cursor: string | undefined;
  let hasMore = true;
  const paginationGuard = createLinearPaginationGuard("fetchAllIssuesPaginated");

  while (hasMore) {
    const requestCursor = cursor || null;
    // Always include cursor in variables (null for first page)
    const variables = { ...baseVariables, cursor: cursor || null };

    // Build variable declarations - cursor is always included (optional String)
    const varDecls = Object.entries(baseVariables)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => `$${k}: String!`)
      .concat(["$cursor: String"])
      .join(", ");

    const query = `
      query GetAllIssues(${varDecls}) {
        team(id: $teamId) {
          issues(${scopeFilter}, first: 50, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              ${ISSUE_FRAGMENT}
            }
          }
        }
      }
    `;

    const result = await client.request<{
      team: {
        issues: {
          pageInfo: { hasNextPage: boolean; endCursor?: string };
          nodes: LinearIssue[];
        };
      };
    }>(query, variables);

    const issues = result.team.issues.nodes.map(linearToBdIssue);

    // Track all issue IDs for stale pruning
    for (const issue of issues) {
      allIssueIds.add(issue.id);
    }

    // Upsert issues
    if (issues.length > 0) {
      cacheIssues(issues);
    }

    // Cache parent-child relations
    for (const linear of result.team.issues.nodes) {
      if (linear.parent) {
        cacheDependency({
          issue_id: linear.identifier,
          depends_on_id: linear.parent.identifier,
          type: "parent-child",
          created_at: linear.createdAt,
          created_by: "sync",
        });
      }
    }

    allIssues.push(...issues);
    hasMore = result.team.issues.pageInfo.hasNextPage;
    cursor = paginationGuard.nextCursor(result.team.issues.pageInfo, requestCursor) || undefined;
  }

  // Prune stale issues that are no longer in remote
  const pruned = pruneStaleIssues(allIssueIds);

  updateLastSync();
  updateLastFullSync();

  return { issues: allIssues, pruned };
}

/**
 * Fetch issues updated since a given timestamp (incremental sync).
 * Does NOT clear cache - only upserts updated issues.
 * Supports pagination via cursor.
 */
export async function fetchUpdatedIssues(
  teamId: string,
  since: string,
  cursor?: string
): Promise<{ issues: Issue[]; hasMore: boolean; endCursor?: string }> {
  const client = getGraphQLClient();
  const scope = getRepoScope();

  // Build scope filter based on mode
  let scopeFilter: string;
  let baseVariables: Record<string, string> = { teamId, since };

  if (scope === "project") {
    const projectName = getRepoName() || "unknown";
    scopeFilter = `project: { name: { eq: $projectName } }`;
    baseVariables.projectName = projectName;
  } else if (scope === "both") {
    const repoLabel = getRepoLabel();
    const projectName = getRepoName() || "unknown";
    scopeFilter = `or: [{ labels: { name: { eq: $labelName } } }, { project: { name: { eq: $projectName } } }]`;
    baseVariables.labelName = repoLabel;
    baseVariables.projectName = projectName;
  } else {
    const repoLabel = getRepoLabel();
    scopeFilter = `labels: { name: { eq: $labelName } }`;
    baseVariables.labelName = repoLabel;
  }

  // Build variable declarations
  // Note: since is DateTimeOrDuration type (Linear's custom scalar), cursor is optional String
  const varDecls = Object.keys(baseVariables)
    .map((k) => (k === "since" ? `$${k}: DateTimeOrDuration!` : `$${k}: String!`))
    .concat(["$cursor: String"])
    .join(", ");

  // Variables to send - include cursor as null if undefined
  const variables = { ...baseVariables, cursor: cursor || null };

  // Combined filter: scope + updatedAt
  const filter = `filter: { ${scopeFilter}, updatedAt: { gt: $since } }`;

  const query = `
    query GetUpdatedIssues(${varDecls}) {
      team(id: $teamId) {
        issues(${filter}, first: 50, after: $cursor, orderBy: updatedAt) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            ${ISSUE_FRAGMENT}
          }
        }
      }
    }
  `;

  const result = await client.request<{
    team: {
      issues: {
        pageInfo: { hasNextPage: boolean; endCursor?: string };
        nodes: LinearIssue[];
      };
    };
  }>(query, variables);

  const issues = result.team.issues.nodes.map(linearToBdIssue);

  // Upsert issues (don't clear cache)
  if (issues.length > 0) {
    cacheIssues(issues);
  }

  // Cache parent-child relations from the query
  for (const linear of result.team.issues.nodes) {
    if (linear.parent) {
      cacheDependency({
        issue_id: linear.identifier,
        depends_on_id: linear.parent.identifier,
        type: "parent-child",
        created_at: linear.createdAt,
        created_by: "sync",
      });
    }
  }

  return {
    issues,
    hasMore: result.team.issues.pageInfo.hasNextPage,
    endCursor: result.team.issues.pageInfo.endCursor,
  };
}

/**
 * Fetch all updated issues since timestamp with automatic pagination.
 * Convenience wrapper around fetchUpdatedIssues.
 */
export async function fetchAllUpdatedIssues(teamId: string, since: string): Promise<Issue[]> {
  const allIssues: Issue[] = [];
  let cursor: string | undefined;
  let hasMore = true;
  const paginationGuard = createLinearPaginationGuard("fetchAllUpdatedIssues");

  while (hasMore) {
    const requestCursor = cursor || null;
    const result = await fetchUpdatedIssues(teamId, since, cursor);
    allIssues.push(...result.issues);
    hasMore = result.hasMore;
    cursor =
      paginationGuard.nextCursor(
        {
          hasNextPage: result.hasMore,
          endCursor: result.endCursor,
        },
        requestCursor
      ) || undefined;
  }

  return allIssues;
}

/**
 * Fetch relations for a set of issues (exported for background worker)
 * Fetches in parallel batches for speed
 */
export async function fetchRelations(issueIds: string[]): Promise<void> {
  const client = getGraphQLClient();
  const BATCH_SIZE = 10; // Parallel requests per batch

  const query = `
    query GetIssueRelations($id: String!) {
      issue(id: $id) {
        identifier
        relations {
          nodes {
            type
            relatedIssue {
              identifier
            }
          }
        }
        inverseRelations {
          nodes {
            type
            issue {
              identifier
            }
          }
        }
      }
    }
  `;

  // Process in parallel batches
  for (let i = 0; i < issueIds.length; i += BATCH_SIZE) {
    const batch = issueIds.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (issueId) => {
        try {
          const result = await client.request<{
            issue: {
              identifier: string;
              relations: {
                nodes: Array<{
                  type: string;
                  relatedIssue: { identifier: string };
                }>;
              };
              inverseRelations: {
                nodes: Array<{
                  type: string;
                  issue: { identifier: string };
                }>;
              };
            } | null;
          }>(query, { id: issueId });

          // Cache outgoing relations
          if (result.issue?.relations?.nodes) {
            for (const rel of result.issue.relations.nodes) {
              cacheDependency({
                issue_id: result.issue.identifier,
                depends_on_id: rel.relatedIssue.identifier,
                type: rel.type === "blocks" ? "blocks" : "related",
                created_at: new Date().toISOString(),
                created_by: "sync",
              });
            }
          }

          // Cache incoming relations (inverse)
          if (result.issue?.inverseRelations?.nodes) {
            for (const rel of result.issue.inverseRelations.nodes) {
              cacheDependency({
                issue_id: rel.issue.identifier,
                depends_on_id: result.issue.identifier,
                type: rel.type === "blocks" ? "blocks" : "related",
                created_at: new Date().toISOString(),
                created_by: "sync",
              });
            }
          }
        } catch {
          // Ignore errors for individual relation fetches
        }
      })
    );
  }
}

/**
 * Fetch single issue by ID
 */
export async function fetchIssue(issueId: string): Promise<Issue | null> {
  const client = getGraphQLClient();

  const query = `
    query GetIssue($id: String!) {
      issue(id: $id) {
        ${ISSUE_WITH_RELATIONS_FRAGMENT}
        attachments {
          nodes {
            id
            title
            subtitle
            url
            sourceType
            metadata
            bodyData
          }
        }
      }
    }
  `;

  try {
    const result = await client.request<{ issue: LinearIssue | null }>(query, {
      id: issueId,
    });

    if (!result.issue) return null;

    registerIssueAttachments(issueId, result.issue);
    const issue = linearToBdIssue(result.issue);
    cacheIssue(issue);

    // Clear old deps before caching fresh ones (prevents stale data)
    clearIssueDependencies(result.issue.identifier);

    // Cache parent-child relation
    if (result.issue.parent) {
      cacheDependency({
        issue_id: result.issue.identifier,
        depends_on_id: result.issue.parent.identifier,
        type: "parent-child",
        created_at: result.issue.createdAt,
        created_by: "sync",
      });
    }

    // Cache other relations (outgoing: this issue blocks/relates to others)
    if (result.issue.relations?.nodes) {
      for (const rel of result.issue.relations.nodes) {
        cacheDependency({
          issue_id: result.issue.identifier,
          depends_on_id: rel.relatedIssue.identifier,
          type: rel.type === "blocks" ? "blocks" : "related",
          created_at: result.issue.createdAt,
          created_by: "sync",
        });
      }
    }

    // Cache inverse relations (incoming: this issue is blocked by others)
    if (result.issue.inverseRelations?.nodes) {
      for (const rel of result.issue.inverseRelations.nodes) {
        // Inverse "blocks" means: rel.issue blocks result.issue
        // So we cache: rel.issue -> blocks -> result.issue
        cacheDependency({
          issue_id: rel.issue.identifier,
          depends_on_id: result.issue.identifier,
          type: rel.type === "blocks" ? "blocks" : "related",
          created_at: result.issue.createdAt,
          created_by: "sync",
        });
      }
    }

    return issue;
  } catch {
    return null;
  }
}

/**
 * Find a scoped Linear issue by sync key.
 * New-path issues use syncKey as the Linear UUID (IssueCreateInput.id).
 * Legacy-path issues still rely on the description marker fallback.
 */
export async function findIssueBySyncKey(
  teamId: string,
  syncKey: string,
  options: { client?: GraphqlRequestClient } = {}
): Promise<Issue | null> {
  const client: GraphqlRequestClient =
    options.client || (getGraphQLClient() as unknown as GraphqlRequestClient);
  const scope = getRepoScope();

  if (isUuid(syncKey)) {
    try {
      const byIdQuery = `
        query GetIssueBySyncKeyId($id: String!) {
          issue(id: $id) {
            ${ISSUE_FRAGMENT}
          }
        }
      `;
      const byIdResult = await client.request<{ issue: LinearIssue | null }>(byIdQuery, {
        id: syncKey,
      });
      if (byIdResult.issue) {
        const mapped = linearToBdIssue(byIdResult.issue);
        // Backfill cache sync_key for UUID-path issues that have no legacy marker.
        if (!mapped.sync_key) {
          mapped.sync_key = syncKey;
        }
        return mapped;
      }
    } catch {
      // Fall through to legacy marker scan.
    }
  }

  let scopeFilter: string;
  const baseVariables: Record<string, string | undefined> = { teamId };

  if (scope === "project") {
    const projectName = getRepoName() || "unknown";
    scopeFilter = `filter: { project: { name: { eq: $projectName } } }`;
    baseVariables.projectName = projectName;
  } else if (scope === "both") {
    const repoLabel = getRepoLabel();
    const projectName = getRepoName() || "unknown";
    scopeFilter = `filter: { or: [{ labels: { name: { eq: $labelName } } }, { project: { name: { eq: $projectName } } }] }`;
    baseVariables.labelName = repoLabel;
    baseVariables.projectName = projectName;
  } else {
    const repoLabel = getRepoLabel();
    scopeFilter = `filter: { labels: { name: { eq: $labelName } } }`;
    baseVariables.labelName = repoLabel;
  }

  let cursor: string | undefined;
  let hasMore = true;
  const paginationGuard = createLinearPaginationGuard("findIssueBySyncKey");

  while (hasMore) {
    const requestCursor = cursor || null;
    const variables = { ...baseVariables, cursor: cursor || null };
    const varDecls = Object.entries(baseVariables)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => `$${k}: String!`)
      .concat(["$cursor: String"])
      .join(", ");
    const query = `
      query FindIssueBySyncKey(${varDecls}) {
        team(id: $teamId) {
          issues(${scopeFilter}, first: 50, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              ${ISSUE_FRAGMENT}
            }
          }
        }
      }
    `;

    const result = await client.request<{
      team: {
        issues: {
          pageInfo: { hasNextPage: boolean; endCursor?: string };
          nodes: LinearIssue[];
        };
      };
    }>(query, variables);

    for (const node of result.team.issues.nodes) {
      const parsed = splitDescriptionAndSyncKey(node.description);
      if (parsed.syncKey === syncKey) {
        return linearToBdIssue(node);
      }
    }

    hasMore = result.team.issues.pageInfo.hasNextPage;
    cursor = paginationGuard.nextCursor(result.team.issues.pageInfo, requestCursor) || undefined;
  }

  return null;
}

/**
 * Resolve issue identifier (e.g., LIN-123) to UUID
 */
export async function resolveIssueId(issueId: string): Promise<string | null> {
  const client = getGraphQLClient();

  const query = `
    query GetIssue($id: String!) {
      issue(id: $id) {
        id
      }
    }
  `;

  try {
    const result = await client.request<{ issue: { id: string } | null }>(query, {
      id: issueId,
    });
    return result.issue?.id || null;
  } catch {
    return null;
  }
}

/**
 * Create issue in Linear
 */
export async function createIssue(params: {
  title: string;
  description?: string;
  priority: Priority;
  issueType?: IssueType; // Optional - only used when use_types is enabled
  teamId: string;
  parentId?: string;
  assigneeId?: string;
  status?: IssueStatus;
  syncKey?: string;
  skipCache?: boolean;
  autoFormatEscapedNewlines?: boolean;
  client?: GraphqlRequestClient;
}): Promise<Issue> {
  const client: GraphqlRequestClient =
    params.client || (getGraphQLClient() as unknown as GraphqlRequestClient);

  const stateId = await getWorkflowStateId(params.teamId, params.status || "open", { client });

  // Resolve parentId if provided (identifier -> UUID)
  let parentUuid: string | undefined;
  if (params.parentId) {
    parentUuid = (await resolveIssueId(params.parentId)) || undefined;
    if (!parentUuid) {
      throw new Error(`Parent issue not found: ${params.parentId}`);
    }
  }

  const mutation = `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          ${ISSUE_FRAGMENT}
        }
      }
    }
  `;

  const buildInput = async (
    forceRefreshScopeBindings: boolean
  ): Promise<Record<string, unknown>> => {
    const labelIds: string[] = [];

    if (useLabelScope()) {
      const repoLabelId = await ensureRepoLabel(params.teamId, {
        client,
        forceRefresh: forceRefreshScopeBindings,
      });
      labelIds.push(repoLabelId);
    }

    if (useTypes() && params.issueType) {
      const typeLabelId = await ensureTypeLabel(params.teamId, params.issueType, {
        forceRefresh: forceRefreshScopeBindings,
      });
      labelIds.push(typeLabelId);
    }

    let projectId: string | undefined;
    if (useProjectScope()) {
      projectId = await ensureRepoProject(params.teamId, {
        forceRefresh: forceRefreshScopeBindings,
      });
    }

    const input: Record<string, unknown> = {
      title: params.title,
      description: await toLinearRichDescription(params.description, {
        client,
        autoFormatEscapedNewlines: params.autoFormatEscapedNewlines,
      }),
      priority: priorityToLinear(params.priority),
      teamId: params.teamId,
      stateId,
      parentId: parentUuid,
    };
    if (isUuid(params.syncKey)) {
      // Hidden idempotency key path: use sync key as Linear UUID.
      input.id = params.syncKey;
    }

    if (labelIds.length > 0) {
      input.labelIds = labelIds;
    }

    if (projectId) {
      input.projectId = projectId;
    }

    if (params.assigneeId) {
      input.assigneeId = params.assigneeId;
    }

    return input;
  };

  const shouldRetryWithRefreshedBindings = (error: unknown): boolean => {
    if (!(error instanceof Error)) return false;
    const msg = error.message.toLowerCase();
    return msg.includes("labelids") || msg.includes("projectid");
  };

  let result:
    | {
        issueCreate: { success: boolean; issue: LinearIssue | null };
      }
    | undefined;
  try {
    const input = await buildInput(false);
    result = await client.request<{
      issueCreate: { success: boolean; issue: LinearIssue | null };
    }>(mutation, { input });
  } catch (error) {
    if (!shouldRetryWithRefreshedBindings(error)) {
      throw error;
    }

    const input = await buildInput(true);
    result = await client.request<{
      issueCreate: { success: boolean; issue: LinearIssue | null };
    }>(mutation, { input });
  }

  if (!result.issueCreate.success || !result.issueCreate.issue) {
    throw new Error("Failed to create issue");
  }

  const issue = linearToBdIssue(result.issueCreate.issue);
  if (!params.skipCache) {
    cacheIssue(issue);
  }
  return issue;
}

/**
 * Update issue in Linear
 */
export async function updateIssue(
  issueId: string,
  updates: {
    title?: string;
    description?: string;
    status?: Issue["status"];
    priority?: Priority;
    assigneeId?: string | null;
  },
  teamId: string,
  options: { client?: GraphqlRequestClient; autoFormatEscapedNewlines?: boolean } = {}
): Promise<Issue> {
  const client: GraphqlRequestClient =
    options.client || (getGraphQLClient() as unknown as GraphqlRequestClient);

  // Build input
  const input: Record<string, unknown> = {};
  if (updates.title) input.title = updates.title;
  if (updates.description !== undefined) {
    input.description = await toLinearRichDescription(updates.description, {
      client,
      autoFormatEscapedNewlines: options.autoFormatEscapedNewlines,
    });
  } else {
    await applyDeferredDescriptionAutoHeal(issueId, input, client);
  }
  if (updates.priority !== undefined) input.priority = priorityToLinear(updates.priority);
  if (updates.status) {
    input.stateId = await getWorkflowStateId(teamId, updates.status, { client });
  }
  if (updates.assigneeId !== undefined) {
    input.assigneeId = updates.assigneeId;
  }

  const mutation = `
    mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          ${ISSUE_FRAGMENT}
        }
      }
    }
  `;

  const result = await client.request<{
    issueUpdate: { success: boolean; issue: LinearIssue | null };
  }>(mutation, { id: issueId, input });

  if (!result.issueUpdate.success || !result.issueUpdate.issue) {
    throw new Error("Failed to update issue");
  }

  const issue = linearToBdIssue(result.issueUpdate.issue);
  cacheIssue(issue);
  return issue;
}

async function applyDeferredDescriptionAutoHeal(
  issueId: string,
  input: Record<string, unknown>,
  client: GraphqlRequestClient
): Promise<void> {
  if (input.description !== undefined) {
    return;
  }

  const query = `
    query GetIssueDescriptionForHeal($id: String!) {
      issue(id: $id) {
        description
      }
    }
  `;

  try {
    const result = await client.request<{
      issue: {
        description?: string | null;
      } | null;
    }>(query, { id: issueId });

    const currentDescription = result.issue?.description ?? undefined;
    if (currentDescription === undefined) {
      return;
    }

    const healedDescription = await toLinearRichDescription(currentDescription, { client });
    if (healedDescription !== undefined && healedDescription !== currentDescription) {
      input.description = healedDescription;
    }
  } catch {
    // Best effort only. Update should still proceed even if description heal lookup fails.
  }
}

/**
 * Update issue parent in Linear
 * Pass null to remove the parent
 */
export async function updateIssueParent(issueId: string, parentId: string | null): Promise<void> {
  const client = getGraphQLClient();

  // Resolve parentId if it's an identifier (only if not null)
  const parentUuid = parentId ? (await resolveIssueId(parentId)) || parentId : null;

  const mutation = `
    mutation UpdateIssueParent($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
      }
    }
  `;

  const result = await client.request<{
    issueUpdate: { success: boolean };
  }>(mutation, { id: issueId, input: { parentId: parentUuid } });

  if (!result.issueUpdate.success) {
    throw new Error("Failed to set parent");
  }
}

/**
 * Close issue in Linear
 */
export async function closeIssue(
  issueId: string,
  teamId: string,
  reason?: string,
  options: { client?: GraphqlRequestClient } = {}
): Promise<Issue> {
  const client: GraphqlRequestClient =
    options.client || (getGraphQLClient() as unknown as GraphqlRequestClient);
  const stateId = await getWorkflowStateId(teamId, "closed", { client });

  // Build input - add reason as comment if provided
  const input: Record<string, unknown> = { stateId };
  await applyDeferredDescriptionAutoHeal(issueId, input, client);

  const mutation = `
    mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          ${ISSUE_FRAGMENT}
        }
      }
    }
  `;

  const result = await client.request<{
    issueUpdate: { success: boolean; issue: LinearIssue | null };
  }>(mutation, { id: issueId, input });

  if (!result.issueUpdate.success || !result.issueUpdate.issue) {
    throw new Error("Failed to close issue");
  }

  // Add close reason as comment if provided
  if (reason) {
    const commentMutation = `
      mutation CreateComment($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
        }
      }
    `;
    await client.request(commentMutation, {
      input: {
        issueId,
        body: `Closed: ${reason}`,
      },
    });
  }

  const issue = linearToBdIssue(result.issueUpdate.issue);
  cacheIssue(issue);
  return issue;
}

/**
 * Create relation between issues
 */
function normalizeRelationType(value: string): RelationType | null {
  const normalized = value.toLowerCase();
  if (normalized === "blocks" || normalized === "related") {
    return normalized;
  }
  return null;
}

function relationTypeMatches(value: string, expected?: RelationType): boolean {
  const normalized = normalizeRelationType(value);
  if (!normalized) {
    return false;
  }
  if (!expected) {
    return true;
  }
  return normalized === expected;
}

async function fetchIssueRelationNodes(
  client: ReturnType<typeof getGraphQLClient>,
  issueId: string
): Promise<LinearRelationNode[]> {
  const query = `
    query GetIssueRelations($id: String!) {
      issue(id: $id) {
        relations {
          nodes {
            id
            type
            relatedIssue {
              id
            }
          }
        }
      }
    }
  `;

  const result = await client.request<{
    issue: {
      relations: {
        nodes: LinearRelationNode[];
      };
    } | null;
  }>(query, { id: issueId });

  if (!result.issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  return result.issue.relations.nodes;
}

export function collectRelationIdsForPair(
  sourceIssueRelations: LinearRelationNode[],
  targetIssueRelations: LinearRelationNode[],
  sourceIssueId: string,
  targetIssueId: string,
  relationType?: RelationType
): string[] {
  const ids = new Set<string>();

  for (const relation of sourceIssueRelations) {
    if (
      relation.relatedIssue.id === targetIssueId &&
      relationTypeMatches(relation.type, relationType)
    ) {
      ids.add(relation.id);
    }
  }

  for (const relation of targetIssueRelations) {
    if (
      relation.relatedIssue.id === sourceIssueId &&
      relationTypeMatches(relation.type, relationType)
    ) {
      ids.add(relation.id);
    }
  }

  return [...ids];
}

async function deleteRelationById(
  client: ReturnType<typeof getGraphQLClient>,
  relationId: string
): Promise<void> {
  const deleteMutation = `
    mutation DeleteRelation($id: String!) {
      issueRelationDelete(id: $id) {
        success
      }
    }
  `;

  const deleteResult = await client.request<{
    issueRelationDelete: { success: boolean };
  }>(deleteMutation, { id: relationId });

  if (!deleteResult.issueRelationDelete.success) {
    throw new Error("Failed to delete relation");
  }
}

export async function createRelation(
  issueId: string,
  relatedIssueId: string,
  type: RelationType
): Promise<void> {
  const client = getGraphQLClient();

  // Resolve identifiers to UUIDs
  const issueUuid = (await resolveIssueId(issueId)) || issueId;
  const relatedUuid = (await resolveIssueId(relatedIssueId)) || relatedIssueId;

  const [issueRelations, relatedIssueRelations] = await Promise.all([
    fetchIssueRelationNodes(client, issueUuid),
    fetchIssueRelationNodes(client, relatedUuid),
  ]);

  const existing = collectRelationIdsForPair(
    issueRelations,
    relatedIssueRelations,
    issueUuid,
    relatedUuid,
    type
  );
  if (existing.length > 0) {
    cacheDependency({
      issue_id: issueId,
      depends_on_id: relatedIssueId,
      type,
      created_at: new Date().toISOString(),
      created_by: "user",
    });
    return;
  }

  const mutation = `
    mutation CreateRelation($input: IssueRelationCreateInput!) {
      issueRelationCreate(input: $input) {
        success
      }
    }
  `;

  const result = await client.request<{
    issueRelationCreate: { success: boolean };
  }>(mutation, {
    input: {
      issueId: issueUuid,
      relatedIssueId: relatedUuid,
      type,
    },
  });

  if (!result.issueRelationCreate.success) {
    throw new Error("Failed to create relation");
  }

  // Cache the dependency
  cacheDependency({
    issue_id: issueId,
    depends_on_id: relatedIssueId,
    type,
    created_at: new Date().toISOString(),
    created_by: "user",
  });
}

/**
 * Delete a relation between two issues
 */
export async function deleteRelation(
  issueId: string,
  relatedIssueId: string,
  relationType?: RelationType
): Promise<void> {
  const client = getGraphQLClient();

  // Resolve identifiers to UUIDs
  const issueUuid = (await resolveIssueId(issueId)) || issueId;
  const relatedUuid = (await resolveIssueId(relatedIssueId)) || relatedIssueId;
  const [issueRelations, relatedIssueRelations] = await Promise.all([
    fetchIssueRelationNodes(client, issueUuid),
    fetchIssueRelationNodes(client, relatedUuid),
  ]);

  let relationIds: string[] = [];
  let removedInverseOnly = false;
  if (relationType === "blocks") {
    const direct = issueRelations
      .filter(
        (relation) =>
          relation.relatedIssue.id === relatedUuid && relationTypeMatches(relation.type, "blocks")
      )
      .map((relation) => relation.id);

    if (direct.length > 0) {
      relationIds = direct;
    } else {
      relationIds = relatedIssueRelations
        .filter(
          (relation) =>
            relation.relatedIssue.id === issueUuid && relationTypeMatches(relation.type, "blocks")
        )
        .map((relation) => relation.id);
      removedInverseOnly = relationIds.length > 0;
    }
  } else {
    relationIds = collectRelationIdsForPair(
      issueRelations,
      relatedIssueRelations,
      issueUuid,
      relatedUuid,
      relationType
    );
  }

  if (relationIds.length === 0) {
    const descriptor = relationType ? `${relationType} relation` : "relation";
    throw new Error(`No ${descriptor} found between ${issueId} and ${relatedIssueId}`);
  }

  for (const relationId of relationIds) {
    await deleteRelationById(client, relationId);
  }

  if (relationType === "related") {
    deleteRelatedDependency(issueId, relatedIssueId);
    return;
  }

  if (relationType === "blocks") {
    if (removedInverseOnly) {
      deleteDependencyByType(relatedIssueId, issueId, "blocks");
    } else {
      deleteDependencyByType(issueId, relatedIssueId, "blocks");
    }
    return;
  }

  // Legacy mode: remove cached relation regardless of direction/type.
  const { deleteDependency } = await import("./database.js");
  deleteDependency(issueId, relatedIssueId);
}

/**
 * Delete an issue from Linear
 */
export async function deleteIssue(issueId: string): Promise<void> {
  const client = getGraphQLClient();

  // Resolve identifier to UUID if needed
  const issueUuid = (await resolveIssueId(issueId)) || issueId;

  const mutation = `
    mutation DeleteIssue($id: String!) {
      issueDelete(id: $id) {
        success
      }
    }
  `;

  const result = await client.request<{
    issueDelete: { success: boolean };
  }>(mutation, { id: issueUuid });

  if (!result.issueDelete.success) {
    throw new Error("Failed to delete issue");
  }
}

/**
 * Add comment to an issue
 */
export async function addComment(issueId: string, body: string): Promise<void> {
  const client = getGraphQLClient();

  const mutation = `
    mutation CreateComment($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
      }
    }
  `;

  const result = await client.request<{
    commentCreate: { success: boolean };
  }>(mutation, {
    input: {
      issueId,
      body,
    },
  });

  if (!result.commentCreate.success) {
    throw new Error("Failed to create comment");
  }
}

/**
 * Verify API connection
 */
export async function verifyConnection(): Promise<{
  userId: string;
  userName: string;
  teams: Array<{ id: string; key: string; name: string }>;
}> {
  const client = getGraphQLClient();

  const query = `
    query Viewer {
      viewer {
        id
        name
      }
      teams {
        nodes {
          id
          key
          name
        }
      }
    }
  `;

  const result = await client.request<{
    viewer: { id: string; name: string };
    teams: { nodes: Array<{ id: string; key: string; name: string }> };
  }>(query);

  return {
    userId: result.viewer.id,
    userName: result.viewer.name,
    teams: result.teams.nodes,
  };
}

/**
 * Get current user (viewer) - for auto-assign
 * Uses cache first, falls back to API call and caches result.
 */
export async function getViewer(): Promise<{ id: string; email: string; name: string }> {
  // Try cache first
  const cached = getCachedViewer();
  if (cached) return cached;

  // Fetch from API
  const client = getGraphQLClient();

  const query = `
    query Viewer {
      viewer {
        id
        email
        name
      }
    }
  `;

  const result = await client.request<{
    viewer: { id: string; email: string; name: string };
  }>(query);

  // Cache for future calls
  cacheViewer(result.viewer);

  return result.viewer;
}

/**
 * Find user by email
 */
export async function getUserByEmail(
  email: string
): Promise<{ id: string; email: string; name: string } | null> {
  const client = getGraphQLClient();

  const query = `
    query GetUser($email: String!) {
      users(filter: { email: { eq: $email } }) {
        nodes {
          id
          email
          name
        }
      }
    }
  `;

  const result = await client.request<{
    users: { nodes: Array<{ id: string; email: string; name: string }> };
  }>(query, { email });

  return result.users.nodes[0] || null;
}
