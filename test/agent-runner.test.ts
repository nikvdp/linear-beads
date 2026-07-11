import { afterEach, describe, expect, test } from "bun:test";
import type { Issue } from "../src/types.js";
import { setRuntimeOverrides } from "../src/utils/config.js";
import { buildAgentInvocation, renderTemplate } from "../src/utils/agent-runner.js";

const issue: Issue = {
  id: "LIN-123",
  linear_identifier: "LIN-123",
  title: "Do not interpolate this $(touch /tmp/nope)",
  status: "open",
  priority: 2,
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
};

afterEach(() => {
  setRuntimeOverrides({ auto_agents: {}, auto_prompt_template: undefined });
});

describe("agent command templating", () => {
  test("single-quotes substituted values so shell syntax stays inert", () => {
    const value = "spaces ' $(printf hacked) `printf hacked`";
    const command = renderTemplate("printf %s {prompt}", { prompt: value });
    const result = Bun.spawnSync(["/bin/sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(value);
  });

  test("rejects unknown placeholders", () => {
    expect(() => renderTemplate("echo {typo}", {})).toThrow(
      "Unknown template placeholder: {typo}"
    );
  });

  test("builds the prompt before placing it in the agent command", () => {
    setRuntimeOverrides({
      auto_agents: { echo: "printf %s {prompt}" },
      auto_prompt_template: "Handle {ticket_id} in {workdir}; run {run_id}; log {log_file}",
    });

    const invocation = buildAgentInvocation({
      issue,
      runId: "run-test",
      workdir: "/tmp/work tree",
      logPath: "/tmp/run.log",
      agentName: "echo",
    });
    const result = Bun.spawnSync(["/bin/sh", "-c", invocation], { stdout: "pipe" });
    const prompt = result.stdout.toString();

    expect(prompt).toContain("Handle 'LIN-123'");
    expect(prompt).toContain("in '/tmp/work tree'");
    expect(prompt).toContain("run 'run-test'");
    expect(prompt).toContain("log '/tmp/run.log'");
    expect(prompt).not.toContain(issue.title);
  });

  test("points missing agent names at auto_agents config", () => {
    setRuntimeOverrides({ auto_agents: {} });
    expect(() =>
      buildAgentInvocation({
        issue,
        runId: "run-test",
        workdir: "/tmp/work",
        logPath: "/tmp/run.log",
        agentName: "missing",
      })
    ).toThrow("No auto_agents command template is configured for agent 'missing'.");
  });
});
