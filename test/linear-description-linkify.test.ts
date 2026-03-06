import { describe, expect, test } from "bun:test";
import { toLinearRichDescription } from "../src/utils/linear.js";

describe("toLinearRichDescription", () => {
  test("rewrites literal team issue IDs to Linear markdown links", () => {
    const output = toLinearRichDescription("Discuss LIN-4274 and ABC-99");
    expect(output).toBe(
      "Discuss [LIN-4274](https://linear.app/issue/LIN-4274) and [ABC-99](https://linear.app/issue/ABC-99)"
    );
  });

  test("does not rewrite LOCAL IDs", () => {
    const output = toLinearRichDescription("Depends on LOCAL-001 before LIN-4274");
    expect(output).toBe(
      "Depends on LOCAL-001 before [LIN-4274](https://linear.app/issue/LIN-4274)"
    );
  });

  test("does not rewrite IDs already inside markdown links", () => {
    const input =
      "Already linked [LIN-4274](https://linear.app/linear-beads/issue/LIN-4274/some-slug) and raw LIN-4387";
    const output = toLinearRichDescription(input);
    expect(output).toBe(
      "Already linked [LIN-4274](https://linear.app/linear-beads/issue/LIN-4274/some-slug) and raw [LIN-4387](https://linear.app/issue/LIN-4387)"
    );
  });

  test("keeps existing angle-bracket Linear links unchanged while encoding raw literals", () => {
    const input =
      "Already [LIN-4274](<https://linear.app/linear-beads/issue/LIN-4274/some-slug>) plus raw LIN-4387";
    const output = toLinearRichDescription(input);
    expect(output).toBe(
      "Already [LIN-4274](<https://linear.app/linear-beads/issue/LIN-4274/some-slug>) plus raw [LIN-4387](https://linear.app/issue/LIN-4387)"
    );
  });

  test("keeps undefined descriptions unchanged", () => {
    expect(toLinearRichDescription(undefined)).toBeUndefined();
  });
});
