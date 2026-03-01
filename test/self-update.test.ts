import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { getBinaryVersion, runSelfUpdate } from "../src/utils/self-update.js";
import packageJson from "../package.json";
import { normalizeReleaseTag } from "../src/utils/release-version.js";

const originalFetch = globalThis.fetch;

function platformAssetName(): string {
  const key = `${process.platform}-${process.arch}`;
  const mapping: Record<string, string> = {
    "linux-x64": "lb-linux-x64",
    "linux-arm64": "lb-linux-arm64",
    "darwin-x64": "lb-darwin-x64",
    "darwin-arm64": "lb-darwin-arm64",
    "win32-x64": "lb-windows-x64.exe",
  };

  const asset = mapping[key];
  if (!asset) {
    throw new Error(`Unsupported platform/arch for test: ${process.platform}/${process.arch}`);
  }

  return asset;
}

function makeReleaseResponse(url: string, version: string, binaryBytes: Uint8Array): Response {
  const binaryName = platformAssetName();
  if (url.includes("checksums")) {
    const checksum = createHash("sha256").update(binaryBytes).digest("hex");
    return new Response(`${checksum}  ${binaryName}\n`);
  }

  if (url.includes("/assets") || url.includes("releases/tags") || url.includes("releases/latest")) {
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

  if (url.includes("/lb/")) {
    return new Response(binaryBytes);
  }

  return new Response("not found", { status: 404 });
}

describe("self-update", () => {
  let tempDir: string;
  let binaryPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lb-self-update-"));
    binaryPath = join(tempDir, process.platform === "win32" ? "lb.exe" : "lb");
    writeFileSync(binaryPath, "old-binary");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("reports up to date when remote matches local", async () => {
    const assetName = platformAssetName();
    const version = packageJson.version?.replace(/^v/, "");
    if (!version) {
      throw new Error("package.json is missing a version");
    }
    const binaryBytes = new TextEncoder().encode(`replacement-${assetName}`);

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      return makeReleaseResponse(String(input), version, binaryBytes);
    }) as typeof fetch;

    const result = await runSelfUpdate({
      version,
      force: false,
      check: true,
      path: binaryPath,
    });

    expect(result.alreadyUpdated).toBe(true);
    expect(result.localVersion).toBe(normalizeReleaseTag(`v${version}`));
    expect(result.remoteVersion).toBe(normalizeReleaseTag(`v${version}`));
    expect(result.updatedPath).toBeUndefined();
    expect(readFileSync(binaryPath, "utf8")).toBe("old-binary");
  });

  test("uses embedded binary version even when .version sidecar is stale", () => {
    writeFileSync(`${binaryPath}.version`, "v16\n");

    expect(getBinaryVersion(binaryPath)).toBe(normalizeReleaseTag(`v${packageJson.version}`));
  });

  test("installs newer version and replaces binary", async () => {
    const version = "9.9.9";
    const binaryBytes = new TextEncoder().encode(`replacement-${platformAssetName()}`);

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      return makeReleaseResponse(String(input), version, binaryBytes);
    }) as typeof fetch;

    const result = await runSelfUpdate({
      version,
      force: true,
      check: false,
      path: binaryPath,
    });

    expect(result.alreadyUpdated).toBe(false);
    expect(result.updatedPath).toBe(binaryPath);
    expect(result.localVersion).toBe(normalizeReleaseTag(`v${packageJson.version}`));
    expect(result.remoteVersion).toBe(`v${version}`);
    expect(readFileSync(binaryPath, "utf8")).toBe(`replacement-${platformAssetName()}`);
    expect(getBinaryVersion(binaryPath)).toBe(normalizeReleaseTag(`v${packageJson.version}`));

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      return makeReleaseResponse(String(input), version, binaryBytes);
    }) as typeof fetch;

    const checkResult = await runSelfUpdate({
      version: undefined,
      force: false,
      check: true,
      path: binaryPath,
    });

    expect(checkResult.alreadyUpdated).toBe(false);
    expect(checkResult.localVersion).toBe(normalizeReleaseTag(`v${packageJson.version}`));
    expect(checkResult.localVersion).toBe(result.localVersion);
  });

  test("normalizes package.json version for user-facing binary version", () => {
    expect(getBinaryVersion()).toBe(normalizeReleaseTag(`v${packageJson.version}`));
  });

  test("throws on checksum mismatch", async () => {
    const version = "9.9.10";
    const releaseBytes = new TextEncoder().encode("replacement");

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("checksums")) {
        return new Response(`${"a".repeat(64)}  ${platformAssetName()}\n`);
      }
      if (url.includes("/assets") || url.includes("/tags") || url.includes("/latest")) {
        return new Response(
          JSON.stringify({
            tag_name: `v${version}`,
            assets: [
              {
                name: platformAssetName(),
                browser_download_url: "https://example.com/lb/new-binary",
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
      return new Response(releaseBytes);
    }) as typeof fetch;

    await expect(
      runSelfUpdate({
        version,
        force: true,
        check: false,
        path: binaryPath,
      })
    ).rejects.toThrow("Checksum mismatch");

    expect(readFileSync(binaryPath, "utf8")).toBe("old-binary");
  });
});
