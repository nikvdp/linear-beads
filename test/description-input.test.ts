import { describe, expect, test } from "bun:test";
import { rewriteEscapedNewlines } from "../src/utils/description-input.js";

describe("rewriteEscapedNewlines", () => {
  test("converts escaped paragraph/list newlines to real newlines", () => {
    const input = "Why\\n\\n- one\\n- two\\n\\nWhat\\n\\nDone";
    const output = rewriteEscapedNewlines(input);
    expect(output).toBe("Why\n\n- one\n- two\n\nWhat\n\nDone");
  });

  test("aggressively rewrites escaped newline mentions in auto-format mode", () => {
    const input = "Use literal escaped \\n sequences in docs.";
    const output = rewriteEscapedNewlines(input);
    expect(output).toBe("Use literal escaped \n sequences in docs.");
  });

  test("normalizes mixed slash-newline corruption seen in real ticket payloads", () => {
    const input =
      "Why\\\\n\\\\\n\n* Move up/down can target the wrong block.\\\\n\\\\nWhat\\\\n\\\\\n* Audit source.\\\\\n* Ensure active caret block.\\\\n\\\\nWhere\\\\n\\\\\n* apps/web/src/editor/blockTree.ts";
    const output = rewriteEscapedNewlines(input);
    expect(output).not.toContain("\\n");
    expect(output).toContain("Why\n\n* Move up/down can target the wrong block.");
    expect(output).toContain("\n\nWhat\n\n* Audit source.");
    expect(output).toContain("* Ensure active caret block.");
  });
});
