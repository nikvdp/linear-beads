#!/usr/bin/env bun

import { createHash } from "crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { selfUpdateCommand } from "../src/commands/self-update.js";

const ASSET_BY_PLATFORM: Record<string, string> = {
  "linux-x64": "lb-linux-x64",
  "linux-arm64": "lb-linux-arm64",
  "darwin-x64": "lb-darwin-x64",
  "darwin-arm64": "lb-darwin-arm64",
  "win32-x64": "lb-windows-x64.exe",
};

function platformAssetName(): string {
  const key = `${process.platform}-${process.arch}`;
  const asset = ASSET_BY_PLATFORM[key];
  if (!asset) {
    throw new Error(`Unsupported platform/arch for demo: ${process.platform}/${process.arch}`);
  }
  return asset;
}

function makeReleaseResponse(url: string, version: string, binaryBytes: Uint8Array): Response {
  const binaryName = platformAssetName();

  if (url.includes("checksums.txt")) {
    const checksum = createHash("sha256").update(binaryBytes).digest("hex");
    return new Response(`${checksum}  ${binaryName}\n`);
  }

  if (url.includes("releases/tags") || url.includes("releases/latest")) {
    return new Response(
      JSON.stringify({
        tag_name: `v${version}`,
        assets: [
          {
            name: binaryName,
            browser_download_url: `https://example.com/lb/${binaryName}`,
          },
          {
            name: "checksums.txt",
            browser_download_url: "https://example.com/lb/checksums.txt",
          },
        ],
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  if (url.includes(`/lb/${binaryName}`)) {
    return new Response(binaryBytes);
  }

  return new Response("not found", { status: 404 });
}

async function main(): Promise<void> {
  const assetName = platformAssetName();
  const version = "9.9.9";
  const checkOnly = process.argv.includes("--check");
  const binaryBytes = new TextEncoder().encode(`replacement-${assetName}`);
  const originalFetch = globalThis.fetch;
  const tempDir = mkdtempSync(join(tmpdir(), "lb-self-update-demo-"));
  const binaryPath = join(tempDir, process.platform === "win32" ? "lb.exe" : "lb");

  writeFileSync(binaryPath, "old-binary");

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    return makeReleaseResponse(String(input), version, binaryBytes);
  }) as typeof fetch;

  console.log(`Demo binary: ${binaryPath}`);
  console.log(`Mode: ${checkOnly ? "check-only" : "install"}`);
  console.log("");

  try {
    const args = ["node", "self-update", "--path", binaryPath, "--tag", version];
    if (checkOnly) {
      args.push("--check");
    } else {
      args.push("--force");
    }

    await selfUpdateCommand.parseAsync(args, { from: "user" });

    if (!checkOnly) {
      console.log("");
      console.log(`Installed bytes: ${readFileSync(binaryPath, "utf8")}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
