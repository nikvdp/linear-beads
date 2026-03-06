import { describe, expect, test } from "bun:test";
import { rewriteEscapedNewlines } from "../src/utils/description-input.js";
import {
  buildLbRefUrl,
  encodeIssueRefsInDescription,
  parseLbRefUrl,
  renderIssueLinksAsPlainText,
  upgradeLbRefLinks,
} from "../src/utils/linear.js";

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

describe("issue reference codec helpers", () => {
  test("builds and parses lb-ref URLs with sync key identity", () => {
    const url = buildLbRefUrl("123e4567-e89b-12d3-a456-426614174000", "LOCAL-001");
    expect(url).toContain("lb-ref.invalid/issue");
    const parsed = parseLbRefUrl(url);
    expect(parsed).toEqual({
      syncKey: "123e4567-e89b-12d3-a456-426614174000",
      hint: "LOCAL-001",
    });
  });

  test("encodes plain TEAM refs without hardcoding LIN", async () => {
    const encoded = await encodeIssueRefsInDescription("depends on ABC-42 and LIN-7", (token) => ({
      text: token,
      url: `https://linear.app/issue/${token}`,
    }));
    expect(encoded).toContain("[ABC-42](https://linear.app/issue/ABC-42)");
    expect(encoded).toContain("[LIN-7](https://linear.app/issue/LIN-7)");
  });

  test("preserves unresolved lb-ref links when sync key is unknown", () => {
    const unresolved =
      "[LOCAL-001](https://lb-ref.invalid/issue?sync_key=123e4567-e89b-12d3-a456-426614174000&hint=LOCAL-001)";
    const upgraded = upgradeLbRefLinks(unresolved, () => null);
    expect(upgraded).toBe(unresolved);
  });

  test("upgrades lb-ref links when sync key resolves to a Linear issue URL", () => {
    const unresolved =
      "[LOCAL-001](https://lb-ref.invalid/issue?sync_key=123e4567-e89b-12d3-a456-426614174000&hint=LOCAL-001)";
    const upgraded = upgradeLbRefLinks(unresolved, () => "https://linear.app/issue/LIN-1234");
    expect(upgraded).toBe("[LOCAL-001](https://linear.app/issue/LIN-1234)");
  });

  test("renders issue links back to plain textual IDs for CLI output", () => {
    const rich =
      "Blocks [LOCAL-001](https://lb-ref.invalid/issue?sync_key=123e4567-e89b-12d3-a456-426614174000&hint=LOCAL-001) and [ABC-42](https://linear.app/workspace/issue/ABC-42).";
    const plain = renderIssueLinksAsPlainText(rich);
    expect(plain).toBe("Blocks LOCAL-001 and ABC-42.");
  });
});
