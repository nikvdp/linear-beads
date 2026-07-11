import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

const CONFIG_URL = pathToFileURL(join(import.meta.dir, "..", "src", "utils", "config.ts")).href;
const DEFAULT_PROMPT =
  "Use the lb-auto-mode skill to handle ticket {ticket_id}. Your working directory is {workdir}. Create a branch before making changes.";
const tempDirs: string[] = [];

type Config = Record<string, unknown>;

type AutoConfigSnapshot = {
  label: string;
  intervalMs: number;
  agentName: string | null;
  agentError: string | null;
  templates: Record<string, string | null>;
  prompt: string;
};

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createFixture(
  globalConfig: Config = {},
  repoConfig: Config = {}
): {
  homeDir: string;
  repoDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "lb-auto-config-"));
  tempDirs.push(root);
  const homeDir = join(root, "home");
  const repoDir = join(root, "repo");

  mkdirSync(join(homeDir, ".config", "lb"), { recursive: true });
  mkdirSync(join(repoDir, ".lb"), { recursive: true });
  writeFileSync(
    join(homeDir, ".config", "lb", "config.jsonc"),
    `${JSON.stringify(globalConfig, null, 2)}\n`
  );
  writeFileSync(join(repoDir, ".lb", "config.jsonc"), `${JSON.stringify(repoConfig, null, 2)}\n`);

  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: repoDir });
  if (init.exitCode !== 0) {
    throw new Error("Failed to initialize temporary git repository");
  }

  return { homeDir, repoDir };
}

function readAutoConfig(
  fixture: { homeDir: string; repoDir: string },
  options: { cliAgent?: string; intervalOverride?: "infinity" } = {}
): AutoConfigSnapshot {
  const script = `
    import {
      getAutoAgentName,
      getAutoAgentTemplate,
      getAutoLabel,
      getAutoPollIntervalMs,
      getAutoPromptTemplate,
      setRuntimeOverrides,
    } from ${JSON.stringify(CONFIG_URL)};

    if (process.env.TEST_INTERVAL_OVERRIDE === "infinity") {
      setRuntimeOverrides({ auto_poll_interval_seconds: Infinity });
    }

    let agentName = null;
    let agentError = null;
    try {
      agentName = getAutoAgentName(process.env.TEST_CLI_AGENT || undefined);
    } catch (error) {
      agentError = error instanceof Error ? error.message : String(error);
    }

    console.log(JSON.stringify({
      label: getAutoLabel(),
      intervalMs: getAutoPollIntervalMs(),
      agentName,
      agentError,
      templates: {
        claude: getAutoAgentTemplate("claude") ?? null,
        codex: getAutoAgentTemplate("codex") ?? null,
        gemini: getAutoAgentTemplate("gemini") ?? null,
        unknown: getAutoAgentTemplate("unknown") ?? null,
      },
      prompt: getAutoPromptTemplate(),
    }));
  `;

  const result = Bun.spawnSync(["bun", "--eval", script], {
    cwd: fixture.repoDir,
    env: {
      ...process.env,
      HOME: fixture.homeDir,
      LINEAR_API_KEY: "",
      LB_TEAM_KEY: "",
      TEST_CLI_AGENT: options.cliAgent || "",
      TEST_INTERVAL_OVERRIDE: options.intervalOverride || "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8"));
  }

  return JSON.parse(Buffer.from(result.stdout).toString("utf8")) as AutoConfigSnapshot;
}

describe("auto-mode config", () => {
  test("uses defaults and reports a distinct missing-agent error", () => {
    const snapshot = readAutoConfig(createFixture());

    expect(snapshot.label).toBe("auto");
    expect(snapshot.intervalMs).toBe(30000);
    expect(snapshot.prompt).toBe(DEFAULT_PROMPT);
    expect(snapshot.agentName).toBeNull();
    expect(snapshot.agentError).toBe(
      "Auto agent name is required: set auto_agent in config or pass --agent-name."
    );
    expect(snapshot.templates.unknown).toBeNull();
  });

  test("merges agent templates, applies repo values, and lets the CLI agent win", () => {
    const fixture = createFixture(
      {
        auto_label: "global-auto",
        auto_agent: "claude",
        auto_agents: { claude: "global claude", codex: "global codex" },
        auto_prompt_template: "Global prompt for {ticket_id}",
      },
      {
        auto_label: "repo-auto",
        auto_poll_interval_seconds: 9,
        auto_agents: { codex: "repo codex", gemini: "repo gemini" },
      }
    );
    const configuredSnapshot = readAutoConfig(fixture);
    const snapshot = readAutoConfig(fixture, { cliAgent: "codex" });

    expect(configuredSnapshot.agentName).toBe("claude");
    expect(snapshot.label).toBe("repo-auto");
    expect(snapshot.intervalMs).toBe(9000);
    expect(snapshot.agentName).toBe("codex");
    expect(snapshot.agentError).toBeNull();
    expect(snapshot.templates).toEqual({
      claude: "global claude",
      codex: "repo codex",
      gemini: "repo gemini",
      unknown: null,
    });
    expect(snapshot.prompt).toBe("Global prompt for {ticket_id}");
  });

  test.each([
    ["negative", -1, 30000],
    ["zero", 0, 30000],
    ["non-numeric", "soon", 30000],
    ["fractional", 2.5, 30000],
    ["one second", 1, 5000],
    ["four seconds", 4, 5000],
    ["normal", 42, 42000],
  ])("normalizes %s polling values", (_name, value, expected) => {
    const snapshot = readAutoConfig(createFixture({}, { auto_poll_interval_seconds: value }));
    expect(snapshot.intervalMs).toBe(expected);
  });

  test("normalizes non-finite runtime polling values", () => {
    const snapshot = readAutoConfig(createFixture(), { intervalOverride: "infinity" });
    expect(snapshot.intervalMs).toBe(30000);
  });
});
