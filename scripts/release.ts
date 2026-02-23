#!/usr/bin/env bun
/**
 * Prepare a new patch release:
 * - bumps package.json from 0.0.N -> 0.0.(N+1)
 * - commits package.json
 * - creates a tag v(N+1)
 * - does not push
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  formatReleaseVersion,
  parseReleaseTag,
  parseReleaseVersion,
  releaseTag,
} from "../src/utils/release-version.js";

type PackageJson = {
  version?: string;
};

const decoder = new TextDecoder();

function runGit(args: string[], label: string): string {
  const process = Bun.spawnSync({
    cmd: ["git", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  if (process.exitCode !== 0) {
    const errorText = decoder.decode(process.stderr);
    throw new Error(`${label} failed: ${errorText.trim() || `exit code ${process.exitCode}`}`);
  }

  return decoder.decode(process.stdout).trim();
}

function readCurrentPackageVersion(packagePath: string): { version: string } {
  const raw = readFileSync(packagePath, "utf8");
  const data = JSON.parse(raw) as PackageJson;

  if (typeof data.version !== "string") {
    throw new Error(`package.json missing a string version field at ${packagePath}`);
  }

  return { version: data.version };
}

function writePackageVersion(packagePath: string, version: string): void {
  const raw = readFileSync(packagePath, "utf8");
  const data = JSON.parse(raw) as Record<string, unknown>;
  data.version = version;
  writeFileSync(packagePath, `${JSON.stringify(data, null, 2)}\n`);
}

function existingTagPatches(): number[] {
  const output = runGit(["tag", "--list", "v*"], "git tag");
  if (!output) return [];

  return output
    .split("\n")
    .map(parseReleaseTag)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
}

function ensureTagAlignment(currentPatch: number, tagPatches: number[]): void {
  if (tagPatches.length === 0) {
    return;
  }

  const latestTagPatch = tagPatches[tagPatches.length - 1];

  if (latestTagPatch > currentPatch) {
    throw new Error(
      `Tag drift detected: latest tag is ${releaseTag(latestTagPatch)} but package.json is 0.0.${currentPatch}. ` +
        `Bump package.json first with the correct 0.0.N mapping before running this command.`
    );
  }
}

function gitBranch(): string {
  return runGit(["rev-parse", "--abbrev-ref", "HEAD"], "git rev-parse");
}

function main(): void {
  const packagePath = join(process.cwd(), "package.json");
  const packageVersion = readCurrentPackageVersion(packagePath).version;
  const parsed = parseReleaseVersion(packageVersion);

  if (parsed.major !== 0 || parsed.minor !== 0) {
    throw new Error(
      `Expected package.json version to be 0.0.N for release workflow. Found ${formatReleaseVersion(parsed)}.`
    );
  }

  const tagPatches = existingTagPatches();
  ensureTagAlignment(parsed.patch, tagPatches);

  const nextPatch = parsed.patch + 1;
  const nextVersion = formatReleaseVersion({ ...parsed, patch: nextPatch });
  const nextTag = releaseTag(nextPatch);

  if (tagPatches.includes(nextPatch)) {
    throw new Error(`Tag ${nextTag} already exists. Resolve the release state before retrying.`);
  }

  writePackageVersion(packagePath, nextVersion);

  runGit(["add", "package.json"], "git add");
  runGit(["commit", "-m", `release: bump version to ${nextTag}`], "git commit");
  runGit(["tag", nextTag], "git tag");

  const branch = gitBranch();

  console.log("Release prepared.");
  console.log(`package.json: ${formatReleaseVersion(parsed)} -> ${nextVersion}`);
  console.log(`tag created: ${nextTag}`);
  console.log(`  git push origin ${branch}`);
  console.log(`  git push origin ${nextTag}`);
}

main();
