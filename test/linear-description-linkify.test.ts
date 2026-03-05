import { describe, expect, test } from "bun:test";
import { linkifyIssueReferencesForLinear } from "../src/utils/linear.js";

describe("linkifyIssueReferencesForLinear", () => {
  test("rewrites literal team issue IDs to Linear markdown links", () => {
    const output = linkifyIssueReferencesForLinear("Discuss LIN-4274 and ABC-99");
    expect(output).toBe(
      "Discuss [LIN-4274](https://linear.app/issue/LIN-4274) and [ABC-99](https://linear.app/issue/ABC-99)"
    );
  });

  test("does not rewrite LOCAL IDs", () => {
    const output = linkifyIssueReferencesForLinear("Depends on LOCAL-001 before LIN-4274");
    expect(output).toBe(
      "Depends on LOCAL-001 before [LIN-4274](https://linear.app/issue/LIN-4274)"
    );
  });

  test("does not rewrite IDs already inside markdown links", () => {
    const input =
      "Already linked [LIN-4274](https://linear.app/linear-beads/issue/LIN-4274/some-slug) and raw LIN-4387";
    const output = linkifyIssueReferencesForLinear(input);
    expect(output).toBe(
      "Already linked [LIN-4274](https://linear.app/linear-beads/issue/LIN-4274/some-slug) and raw [LIN-4387](https://linear.app/issue/LIN-4387)"
    );
  });

  test("keeps undefined descriptions unchanged", () => {
    expect(linkifyIssueReferencesForLinear(undefined)).toBeUndefined();
  });
});
