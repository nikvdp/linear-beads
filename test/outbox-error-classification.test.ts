import { describe, expect, test } from "bun:test";
import { isIdempotentOutboxSuccessError } from "../src/utils/outbox-processor.js";

describe("outbox error classification", () => {
  test("treats already-absent relation deletes as complete", () => {
    expect(
      isIdempotentOutboxSuccessError(
        "delete_relation",
        "No blocks relation found between LIN-6265 and LIN-6240"
      )
    ).toBe(true);

    expect(
      isIdempotentOutboxSuccessError(
        "delete_relation",
        "No related relation found between LIN-6841 and LIN-6780"
      )
    ).toBe(true);

    expect(
      isIdempotentOutboxSuccessError("delete_relation", "No relation found between A and B")
    ).toBe(true);
  });

  test("does not hide unrelated failures", () => {
    expect(
      isIdempotentOutboxSuccessError(
        "delete_relation",
        "Rate limit exceeded. Only 2500 requests are allowed per 1 hour."
      )
    ).toBe(false);
    expect(
      isIdempotentOutboxSuccessError(
        "create_relation",
        "No blocks relation found between LIN-6265 and LIN-6240"
      )
    ).toBe(false);
  });
});
