import { describe, expect, test } from "bun:test";
import { dedupePendingAgainstFetched } from "../src/commands/comment.js";
import type { IssueComment } from "../src/types.js";

function comment(overrides: Partial<IssueComment> & { body: string }): IssueComment {
  return {
    id: overrides.id ?? `id-${overrides.body}`,
    body: overrides.body,
    author: overrides.author,
    parent_id: overrides.parent_id,
    sync_status: overrides.sync_status ?? "synced",
    created_at: overrides.created_at ?? "2026-10-25T00:00:00.000Z",
  } as IssueComment;
}

describe("MG-2190 dedupePendingAgainstFetched", () => {
  test("drops a pending row whose body+parent already exists as fetched", () => {
    const merged = dedupePendingAgainstFetched([
      comment({ id: "srv", body: "hello", sync_status: "synced" }),
      comment({ id: "local", body: "hello", sync_status: "pending" }),
    ]);
    expect(merged.map((c) => c.id)).toEqual(["srv"]);
  });

  test("keeps pending rows with no fetched counterpart", () => {
    const merged = dedupePendingAgainstFetched([
      comment({ id: "srv", body: "hello", sync_status: "synced" }),
      comment({ id: "local", body: "still queued", sync_status: "pending" }),
    ]);
    expect(merged.map((c) => c.id)).toEqual(["srv", "local"]);
  });

  test("parent_id participates in the match (same body, different parent = keep)", () => {
    const merged = dedupePendingAgainstFetched([
      comment({ id: "srv", body: "same", parent_id: "p1", sync_status: "synced" }),
      comment({ id: "local", body: "same", parent_id: "p2", sync_status: "pending" }),
    ]);
    expect(merged.map((c) => c.id)).toEqual(["srv", "local"]);
  });

  test("synced rows are never dropped", () => {
    const merged = dedupePendingAgainstFetched([
      comment({ id: "a", body: "dup", sync_status: "synced" }),
      comment({ id: "b", body: "dup", sync_status: "synced" }),
    ]);
    expect(merged).toHaveLength(2);
  });
});
