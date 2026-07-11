import { afterEach, describe, expect, test } from "bun:test";
import { buildAutoIssueQuery } from "../src/utils/auto.js";
import { setRuntimeOverrides } from "../src/utils/config.js";

afterEach(() => {
  setRuntimeOverrides({ repo_scope: "label", repo_name: "linear-beads-lb" });
});

describe("auto discovery query", () => {
  test("combines repo label, auto label, and open-state filters", () => {
    setRuntimeOverrides({ repo_scope: "label", repo_name: "fixture" });
    const { query, variables } = buildAutoIssueQuery("team-1", "auto");

    expect(variables).toEqual({
      teamId: "team-1",
      labelName: "auto",
      repoLabel: "repo:fixture",
    });
    expect(query).toContain("filter: { and:");
    expect(query).toContain("labels: { name: { eq: $repoLabel } }");
    expect(query).toContain("labels: { name: { eq: $labelName } }");
    expect(query).toContain('state: { type: { eq: "unstarted" } }');
    expect(query).toContain("first: 50");
  });

  test("uses project scope without a repo label", () => {
    setRuntimeOverrides({ repo_scope: "project", repo_name: "fixture" });
    const { query, variables } = buildAutoIssueQuery("team-1", "auto:codex-a");

    expect(variables).toEqual({
      teamId: "team-1",
      labelName: "auto:codex-a",
      projectName: "fixture",
    });
    expect(query).toContain("project: { name: { eq: $projectName } }");
    expect(query).not.toContain("$repoLabel");
  });

  test("uses the established label-or-project scope for both mode", () => {
    setRuntimeOverrides({ repo_scope: "both", repo_name: "fixture" });
    const { query, variables } = buildAutoIssueQuery("team-1", "auto");

    expect(variables.repoLabel).toBe("repo:fixture");
    expect(variables.projectName).toBe("fixture");
    expect(query).toContain("or: [{ labels:");
    expect(query).toContain("{ project:");
  });
});
