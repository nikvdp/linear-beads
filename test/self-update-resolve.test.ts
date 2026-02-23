import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { delimiter, join } from "path";
import { tmpdir } from "os";
import { resolveBinaryPath } from "../src/utils/self-update.js";

describe("self-update binary resolution", () => {
  let originalArgv0: string;
  let originalArgv: string[];
  let originalExecPath: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    originalArgv0 = process.argv0;
    originalArgv = [...process.argv];
    originalExecPath = process.execPath;
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.argv0 = originalArgv0;
    process.argv = originalArgv;
    process.execPath = originalExecPath;
    process.env.PATH = originalPath;
  });

  test("prefers writable real executable and ignores bunfs virtual paths", () => {
    const root = mkdtempSync(join(tmpdir(), "lb-resolve-"));
    const realBinary = join(root, "lb-bin");
    const ignoredScript = join(root, "ignored.ts");
    writeFileSync(realBinary, "binary");
    writeFileSync(ignoredScript, "source");

    process.argv0 = ignoredScript;
    process.argv[1] = "/$bunfs/root/lb-bin";
    process.execPath = realBinary;

    expect(resolveBinaryPath()).toBe(realBinary);

    rmSync(root, { recursive: true, force: true });
  });

  test("falls back to PATH lookup when argv candidates are Bun virtual paths", () => {
    const root = mkdtempSync(join(tmpdir(), "lb-resolve-path-"));
    const binaryOnPath = join(root, "lb");
    writeFileSync(binaryOnPath, "binary");

    process.env.PATH = [root, process.env.PATH || ""].filter(Boolean).join(delimiter);
    process.argv0 = "/$bunfs/root/lb";
    process.argv[1] = "/private/var/folders/example/$bunfs/root/src/cli.ts";
    process.execPath = "/$bunfs/root/lb";

    expect(resolveBinaryPath()).toBe(binaryOnPath);

    rmSync(root, { recursive: true, force: true });
  });

  test("rejects explicit Bun virtual path targets", () => {
    expect(() => resolveBinaryPath("/$bunfs/root/lb")).toThrow("Cannot update Bun virtual path");
  });
});
