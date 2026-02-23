/**
 * Self-update utility for lb.
 */

import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { basename, dirname, resolve } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import packageJson from "../../package.json";
import { normalizeReleaseTag } from "./release-version";

type GitHubRelease = {
  tag_name: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
};

const GITHUB_REPO = "nikvdp/linear-beads";
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_REPO}`;
const GITHUB_RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases`;
const BUNFS_VIRTUAL_SEGMENT = "/$bunfs/";

const ASSET_BY_PLATFORM: Record<string, string> = {
  "linux-x64": "lb-linux-x64",
  "linux-arm64": "lb-linux-arm64",
  "darwin-x64": "lb-darwin-x64",
  "darwin-arm64": "lb-darwin-arm64",
  "win32-x64": "lb-windows-x64.exe",
};

function githubHeaders(): HeadersInit {
  const headers: HeadersInit = {
    Accept: "application/vnd.github+json",
    "User-Agent": "lb-self-update",
  };

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function normalizeTag(tag: string): string {
  return tag.startsWith("v") ? tag : `v${tag}`;
}

function isBunVirtualPath(candidate: string): boolean {
  const normalized = candidate.replaceAll("\\", "/");
  return normalized.includes(BUNFS_VIRTUAL_SEGMENT);
}

function isExecutablePath(candidate: string): boolean {
  if (isBunVirtualPath(candidate)) {
    return false;
  }

  const fileName = basename(candidate);
  if (fileName === "bun" || fileName === "bun.exe") {
    return false;
  }

  // Avoid accidentally treating source files as the executable when running
  // `bun run src/cli.ts` during development.
  if (fileName.endsWith(".ts") || fileName.endsWith(".js") || fileName.endsWith(".mjs")) {
    return false;
  }

  try {
    const stats = statSync(candidate);
    return stats.isFile();
  } catch {
    return false;
  }
}

function pathDirectories(): string[] {
  const rawPath = process.env.PATH;
  if (!rawPath) {
    return [];
  }
  return rawPath.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
}

function commandNameCandidates(commandName: string): string[] {
  if (process.platform !== "win32") {
    return [commandName];
  }

  const lower = commandName.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return [commandName];
  }

  const pathext = (process.env.PATHEXT || ".EXE;.CMD;.BAT")
    .split(";")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const candidates = [commandName];
  for (const ext of pathext) {
    candidates.push(`${commandName}${ext}`);
  }

  return candidates;
}

function findExecutableOnPath(commandName: string): string | undefined {
  const directories = pathDirectories();
  const names = commandNameCandidates(commandName);

  for (const directory of directories) {
    for (const name of names) {
      const candidate = resolve(directory, name);
      if (isExecutablePath(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function parseChecksumFile(text: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-f0-9]{64})\s+\*?(.*)$/i);
    if (!match) continue;
    checksums.set(match[2].trim(), match[1].toLowerCase());
  }
  return checksums;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `GitHub API request failed (${response.status}): ${body || response.statusText}`
    );
  }
  return (await response.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to download file (${response.status}): ${body || response.statusText}`);
  }
  return response.text();
}

function getReleaseApiUrl(version?: string): string {
  if (!version) {
    return `${GITHUB_API_BASE}/releases/latest`;
  }
  return `${GITHUB_API_BASE}/releases/tags/${encodeURIComponent(normalizeReleaseTag(version))}`;
}

function artifactNameForPlatform(): string {
  const key = `${process.platform}-${process.arch}`;
  const asset = ASSET_BY_PLATFORM[key];
  if (!asset) {
    throw new Error(`Unsupported platform/arch: ${process.platform}/${process.arch}`);
  }
  return asset;
}

export function resolveBinaryPath(target?: string): string {
  if (target) {
    const absolute = resolve(target);
    if (isBunVirtualPath(absolute)) {
      throw new Error(
        `Cannot update Bun virtual path: ${absolute}. Re-run with --path /path/to/lb to target the installed executable.`
      );
    }
    try {
      accessSync(absolute, constants.F_OK);
      const stats = statSync(absolute);
      if (!stats.isFile()) {
        throw new Error(`Target is not a regular file: ${absolute}`);
      }
      return absolute;
    } catch {
      throw new Error(`Cannot access --path target binary: ${absolute}`);
    }
  }

  const candidates = [process.argv0, process.argv[1], process.execPath]
    .filter((value): value is string => Boolean(value))
    .map((value) => resolve(value));

  for (const candidate of candidates) {
    if (!isExecutablePath(candidate)) {
      continue;
    }
    return candidate;
  }

  const fallbackCommands = new Set<string>();
  if (process.argv0) {
    fallbackCommands.add(basename(process.argv0));
  }
  fallbackCommands.add("lb");

  for (const commandName of fallbackCommands) {
    const candidate = findExecutableOnPath(commandName);
    if (candidate) {
      return candidate;
    }
  }

  throw new Error(
    "Unable to resolve current lb binary path automatically. Re-run with --path /path/to/lb to target the executable explicitly."
  );
}

function ensureWritableBinaryDirectory(binaryPath: string): void {
  const directory = dirname(binaryPath);
  try {
    accessSync(directory, constants.W_OK);
  } catch {
    throw new Error(
      `Cannot update binary path ${binaryPath}. The directory is not writable: ${directory}. ` +
        "Re-run with --path /path/to/lb and ensure the target path is writable."
    );
  }
}

function versionFilePath(binaryPath: string): string {
  return `${binaryPath}.version`;
}

function readStoredVersion(binaryPath: string): string | undefined {
  try {
    const data = readFileSync(versionFilePath(binaryPath), "utf8").trim();
    if (!data) {
      return undefined;
    }
    return normalizeTag(data);
  } catch {
    return undefined;
  }
}

function currentVersion(binaryPath: string): string {
  return (
    readStoredVersion(binaryPath) || (packageJson.version ? `v${packageJson.version}` : "unknown")
  );
}

export function getBinaryVersion(binaryPath?: string): string {
  if (!binaryPath) {
    return packageJson.version ? normalizeReleaseTag(`v${packageJson.version}`) : "v0.0.0";
  }
  return normalizeReleaseTag(currentVersion(binaryPath));
}

function releaseUrl(version: string): string {
  return `${GITHUB_RELEASES_PAGE}/tag/${version}`;
}

async function downloadReleaseBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to download release asset: ${response.status} ${body || response.statusText}`
    );
  }

  return new Uint8Array(await response.arrayBuffer());
}

function hasFile(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function installDownloadedBinary(downloadPath: string, targetPath: string): void {
  if (process.platform !== "win32") {
    const backupPath = `${targetPath}.lb-update-backup`;
    let hadBackup = false;

    accessSync(dirname(targetPath), constants.W_OK);

    if (hasFile(targetPath)) {
      renameSync(targetPath, backupPath);
      hadBackup = true;
    }

    try {
      renameSync(downloadPath, targetPath);
    } catch (error) {
      if (hadBackup) {
        renameSync(backupPath, targetPath);
      }
      throw error;
    }

    if (hadBackup) {
      try {
        unlinkSync(backupPath);
      } catch {
        // Ignore backup cleanup failures.
      }
    }

    return;
  }

  // On Windows, in-place rename while running is unreliable. Copy is best-effort.
  copyFileSync(downloadPath, targetPath);
}

export type SelfUpdateResult = {
  localVersion: string;
  remoteVersion: string;
  alreadyUpdated: boolean;
  binaryPath: string;
  releaseUrl: string;
  updatedPath?: string;
};

export type SelfUpdateOptions = {
  version?: string;
  check: boolean;
  force: boolean;
  path?: string;
};

export async function runSelfUpdate(options: SelfUpdateOptions): Promise<SelfUpdateResult> {
  const release = await fetchJson<GitHubRelease>(getReleaseApiUrl(options.version));
  const remoteVersion = normalizeReleaseTag(release.tag_name);
  const binaryPath = resolveBinaryPath(options.path);
  const local = normalizeReleaseTag(currentVersion(binaryPath));
  const localClean = normalizeTag(local);
  const binaryName = artifactNameForPlatform();
  const asset = release.assets.find((item) => item.name === binaryName);

  if (!asset) {
    throw new Error(`No release asset found for your platform: ${binaryName}`);
  }

  if (options.check || (remoteVersion === localClean && !options.force)) {
    return {
      localVersion: local,
      remoteVersion,
      alreadyUpdated: remoteVersion === localClean,
      binaryPath,
      releaseUrl: releaseUrl(remoteVersion),
    };
  }

  ensureWritableBinaryDirectory(binaryPath);

  const checksumAsset = release.assets.find((item) => item.name === "checksums.txt");
  const checksumText = checksumAsset ? await fetchText(checksumAsset.browser_download_url) : "";

  const bytes = await downloadReleaseBytes(asset.browser_download_url);

  if (checksumText) {
    const expectedHash = parseChecksumFile(checksumText).get(binaryName);
    if (!expectedHash) {
      throw new Error(`Release checksums missing entry for ${binaryName}`);
    }

    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== expectedHash.toLowerCase()) {
      throw new Error(`Checksum mismatch for ${binaryName}`);
    }
  }

  const stagedPath = `${tmpdir()}/${Date.now()}-${binaryName}`;
  try {
    await Bun.write(stagedPath, bytes);
    installDownloadedBinary(stagedPath, binaryPath);
    chmodSync(binaryPath, 0o755);
    writeFileSync(versionFilePath(binaryPath), `${remoteVersion}\n`, "utf8");
  } finally {
    try {
      unlinkSync(stagedPath);
    } catch {
      // Ignore cleanup failures.
    }
  }

  return {
    localVersion: local,
    remoteVersion,
    alreadyUpdated: false,
    binaryPath,
    updatedPath: binaryPath,
    releaseUrl: releaseUrl(remoteVersion),
  };
}
