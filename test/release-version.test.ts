import { describe, expect, test } from "bun:test";
import {
  formatReleaseVersion,
  parseReleaseTag,
  parseReleaseVersion,
  releaseTag,
} from "../src/utils/release-version.js";

describe("release version helpers", () => {
  test("parses valid release version", () => {
    const parsed = parseReleaseVersion("0.0.14");
    expect(parsed).toEqual({ major: 0, minor: 0, patch: 14 });
  });

  test("rejects invalid release version", () => {
    expect(() => parseReleaseVersion("0.1")).toThrow("Invalid release version");
    expect(() => parseReleaseVersion("1.2.3.4")).toThrow("Invalid release version");
    expect(() => parseReleaseVersion("abc")).toThrow("Invalid release version");
  });

  test("formats release version", () => {
    expect(formatReleaseVersion({ major: 0, minor: 0, patch: 15 })).toBe("0.0.15");
  });

  test("parses release tags", () => {
    expect(parseReleaseTag("v14")).toBe(14);
    expect(parseReleaseTag("v001")).toBe(1);
    expect(parseReleaseTag("release")).toBeUndefined();
  });

  test("formats release tags", () => {
    expect(releaseTag(15)).toBe("v15");
  });
});
