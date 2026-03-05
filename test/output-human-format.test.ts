import { describe, expect, test } from "bun:test";
import { formatIssueHuman } from "../src/utils/output.js";

const BASE_ISSUE = {
  id: "LOCAL-1",
  title: "Output formatting",
  status: "open" as const,
  priority: 2 as const,
  created_at: "2026-03-05T00:00:00.000Z",
  updated_at: "2026-03-05T00:00:00.000Z",
};

describe("formatIssueHuman", () => {
  test("renders plain issue IDs for Linear markdown links in descriptions", () => {
    const output = formatIssueHuman({
      ...BASE_ISSUE,
      description:
        "Refs: [LIN-4084](https://linear.app/linear-beads/issue/LIN-4084/one) and [ABC-4275](<https://linear.app/acme/issue/ABC-4275/two>)",
    });

    expect(output).toContain("Refs: LIN-4084 and ABC-4275");
    expect(output).not.toContain("[LIN-4084](");
    expect(output).not.toContain("[ABC-4275](");
  });

  test("keeps non-Linear links unchanged", () => {
    const output = formatIssueHuman({
      ...BASE_ISSUE,
      description: "Docs: [spec](https://example.com/spec)",
    });

    expect(output).toContain("Docs: [spec](https://example.com/spec)");
  });
});
