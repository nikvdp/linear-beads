import { describe, expect, test } from "bun:test";
import { toLinearRichDescription } from "../src/utils/linear.js";

describe("toLinearRichDescription", () => {
  test("keeps literal team issue IDs as plain text", () => {
    const output = toLinearRichDescription("Discuss LIN-4274 and ABC-99");
    expect(output).toBe("Discuss LIN-4274 and ABC-99");
  });

  test("keeps LOCAL IDs and canonical team IDs as plain text when unresolved locally", () => {
    const output = toLinearRichDescription("Depends on LOCAL-001 before LIN-4274");
    expect(output).toBe("Depends on LOCAL-001 before LIN-4274");
  });

  test("does not rewrite IDs already inside markdown links and keeps raw literals", () => {
    const input =
      "Already linked [LIN-4274](https://linear.app/linear-beads/issue/LIN-4274/some-slug) and raw LIN-4387";
    const output = toLinearRichDescription(input);
    expect(output).toBe(
      "Already linked [LIN-4274](https://linear.app/linear-beads/issue/LIN-4274/some-slug) and raw LIN-4387"
    );
  });

  test("keeps existing angle-bracket Linear links unchanged and keeps raw literals", () => {
    const input =
      "Already [LIN-4274](<https://linear.app/linear-beads/issue/LIN-4274/some-slug>) plus raw LIN-4387";
    const output = toLinearRichDescription(input);
    expect(output).toBe(
      "Already [LIN-4274](<https://linear.app/linear-beads/issue/LIN-4274/some-slug>) plus raw LIN-4387"
    );
  });

  test("keeps undefined descriptions unchanged", () => {
    expect(toLinearRichDescription(undefined)).toBeUndefined();
  });
});
