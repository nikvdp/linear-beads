import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveBinaryPath } from "../src/utils/self-update.js";

describe("self-update binary resolution", () => {
  let originalArgv0: string;
  let originalArgv: string[];
  let originalExecPath: string;

  beforeEach(() => {
    originalArgv0 = process.argv0;
    originalArgv = [...process.argv];
    originalExecPath = process.execPath;
  });

  afterEach(() => {
    process.argv0 = originalArgv0;
    process.argv = originalArgv;
    process.execPath = originalExecPath;
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
});
