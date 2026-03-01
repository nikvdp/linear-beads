import { describe, expect, test } from "bun:test";
import { collectRelationIdsForPair } from "../src/utils/linear.js";

describe("collectRelationIdsForPair", () => {
  test("collects all matching related relation IDs across both directions", () => {
    const issueA = "issue-a";
    const issueB = "issue-b";

    const fromA = [
      { id: "rel-1", type: "related", relatedIssue: { id: issueB } },
      { id: "rel-2", type: "related", relatedIssue: { id: issueB } },
      { id: "rel-3", type: "blocks", relatedIssue: { id: issueB } },
    ];
    const fromB = [
      { id: "rel-4", type: "related", relatedIssue: { id: issueA } },
      { id: "rel-5", type: "related", relatedIssue: { id: issueA } },
      { id: "rel-6", type: "related", relatedIssue: { id: "issue-c" } },
    ];

    const ids = collectRelationIdsForPair(fromA, fromB, issueA, issueB, "related");
    expect(ids.sort()).toEqual(["rel-1", "rel-2", "rel-4", "rel-5"]);
  });

  test("collects type-filtered blocks IDs for the specified pair", () => {
    const issueA = "issue-a";
    const issueB = "issue-b";

    const fromA = [
      { id: "blk-1", type: "blocks", relatedIssue: { id: issueB } },
      { id: "blk-2", type: "blocks", relatedIssue: { id: issueB } },
      { id: "rel-1", type: "related", relatedIssue: { id: issueB } },
    ];
    const fromB = [{ id: "blk-3", type: "blocks", relatedIssue: { id: issueA } }];

    const ids = collectRelationIdsForPair(fromA, fromB, issueA, issueB, "blocks");
    expect(ids.sort()).toEqual(["blk-1", "blk-2", "blk-3"]);
  });
});
