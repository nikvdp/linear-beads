import { describe, expect, test } from "bun:test";
import { mediaDownloadHeadersForUrl } from "../src/commands/media.js";

describe("mediaDownloadHeadersForUrl", () => {
  test("adds Linear authorization for private uploads URLs", () => {
    const headers = mediaDownloadHeadersForUrl(
      "https://uploads.linear.app/example/file.txt",
      "test-linear-key"
    ) as Record<string, string>;

    expect(headers.Authorization).toBe("test-linear-key");
  });

  test("does not add authorization for non-Linear media URLs", () => {
    expect(mediaDownloadHeadersForUrl("https://example.com/file.txt", "test-linear-key")).toBe(
      undefined
    );
  });
});
