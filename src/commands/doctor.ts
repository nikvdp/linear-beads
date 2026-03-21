import { Command } from "commander";
import { chmodSync, existsSync, readFileSync, statSync } from "fs";
import { parse as parseJsonc } from "jsonc-parser";
import { join } from "path";
import {
  getConfig,
  getGlobalConfigPath,
  getHumanOutputStyle,
  getIssueBackendKind,
  getMailBackendKind,
  getRepoConfigPath,
  isLocalOnly,
  reloadConfig,
  writeGlobalConfig,
} from "../utils/config.js";
import { getPendingOutboxItems } from "../utils/database.js";
import {
  getLinearApiErrorInfoFromResponse,
  getLinearRequestPolicy,
  linearFetchWithRetry,
  resetGraphQLClient,
} from "../utils/graphql.js";
import { output } from "../utils/output.js";
import {
  getPidFilePath,
  getWorkerPidFromFile,
  inspectWorkerProcesses,
  isProcessAlive,
  reapZombieWorkerProcesses,
} from "../utils/pid-manager.js";
import {
  clearRemoteSyncPause,
  getActiveRemoteSyncPause,
  getActiveRemoteSyncPauses,
  getAutomaticRemoteSyncPause,
  getAutomaticRemoteSyncPauses,
  isNetworkErrorMessage,
} from "../utils/remote-sync-state.js";
import { getRuntimeCliVersion } from "../utils/runtime-version.js";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

type ConfigFileInfo = {
  primaryPath: string;
  resolvedPath: string;
  exists: boolean;
  data: Record<string, unknown> | null;
};

type ProbeResult =
  | {
      kind: "ok";
      message: string;
      httpStatus: number;
      viewer: { id: string; name: string };
      teams: Array<{ id: string; key: string; name: string }>;
    }
  | {
      kind:
        | "missing_api_key"
        | "auth_error"
        | "rate_limit"
        | "network_error"
        | "graphql_error"
        | "http_error";
      message: string;
      httpStatus?: number;
      errorSummary?: string;
    };

function resolveConfigFile(primaryPath: string): ConfigFileInfo {
  const candidates = primaryPath.endsWith(".jsonc")
    ? [primaryPath, primaryPath.replace(/\.jsonc$/, ".json")]
    : [primaryPath.replace(/\.json$/, ".jsonc"), primaryPath];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    try {
      const parsed = parseJsonc(readFileSync(candidate, "utf-8"));
      const data =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      return {
        primaryPath,
        resolvedPath: candidate,
        exists: true,
        data,
      };
    } catch {
      return {
        primaryPath,
        resolvedPath: candidate,
        exists: true,
        data: null,
      };
    }
  }

  return {
    primaryPath,
    resolvedPath: primaryPath,
    exists: false,
    data: null,
  };
}

function maskKey(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length < 10) {
    return "***";
  }
  return `${normalized.slice(0, 4)}***${normalized.slice(-5)}`;
}

function sanitizeProxyValue(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }

  try {
    const parsed = new URL(value);
    const host = parsed.host || parsed.hostname;
    return `${parsed.protocol}//${host}`;
  } catch {
    return "[set]";
  }
}

function summarizeText(value: string | undefined, maxLength: number = 220): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function isAuthMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("invalid api key") ||
    normalized.includes("invalid auth") ||
    normalized.includes("invalid token") ||
    normalized.includes("not authenticated") ||
    normalized.includes("unauthorized") ||
    normalized.includes("authentication") ||
    normalized.includes("access denied")
  );
}

function errorSummaryFromBody(body: string): string | undefined {
  const normalized = summarizeText(body);
  if (!normalized) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(body) as {
      errors?: Array<{ message?: string; extensions?: { userPresentableMessage?: string } }>;
    };
    const messages = (parsed.errors || [])
      .map((error) => error.extensions?.userPresentableMessage || error.message)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (messages.length > 0) {
      return summarizeText(messages.join(" | "));
    }
  } catch {
    // Ignore JSON parse failures and fall back to raw body.
  }

  return normalized;
}

async function probeLinear(apiKey: string | undefined): Promise<ProbeResult> {
  const normalizedKey = apiKey?.trim();
  if (!normalizedKey) {
    return {
      kind: "missing_api_key",
      message: "No Linear API key is configured.",
    };
  }

  try {
    const policy = getLinearRequestPolicy();
    const response = await linearFetchWithRetry(
      LINEAR_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization: normalizedKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: `
            query DoctorProbe {
              viewer {
                id
                name
              }
              teams {
                nodes {
                  id
                  key
                  name
                }
              }
            }
          `,
        }),
      },
      {
        policy: {
          ...policy,
          timeoutMs: Math.min(policy.timeoutMs, 5000),
          maxRetries: 0,
        },
      }
    );

    const body = await response.text();
    const errorSummary = errorSummaryFromBody(body);
    const structuredResponse = getLinearApiErrorInfoFromResponse({
      status: response.status,
      headers: response.headers,
      body,
    });

    if (!response.ok) {
      const kind =
        response.status === 401 || response.status === 403
          ? "auth_error"
          : structuredResponse.rateLimit
            ? "rate_limit"
            : "http_error";
      return {
        kind,
        message: `Linear probe returned HTTP ${response.status}.`,
        httpStatus: response.status,
        errorSummary,
      };
    }

    let parsed: {
      data?: {
        viewer?: { id?: string; name?: string };
        teams?: { nodes?: Array<{ id: string; key: string; name: string }> };
      };
      errors?: Array<{ message?: string; extensions?: { userPresentableMessage?: string } }>;
    } | null = null;

    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        kind: "http_error",
        message: "Linear probe returned a non-JSON response.",
        httpStatus: response.status,
        errorSummary,
      };
    }

    const graphqlMessages = (parsed?.errors || [])
      .map((error) => error.extensions?.userPresentableMessage || error.message)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);

    if (graphqlMessages.length > 0) {
      const joined = graphqlMessages.join(" | ");
      const structuredGraphql = getLinearApiErrorInfoFromResponse({
        status: response.status,
        headers: response.headers,
        body,
        errors: parsed?.errors,
      });
      return {
        kind: isAuthMessage(joined)
          ? "auth_error"
          : structuredGraphql.rateLimit
            ? "rate_limit"
            : "graphql_error",
        message: "Linear probe returned GraphQL errors.",
        httpStatus: response.status,
        errorSummary: summarizeText(joined),
      };
    }

    const viewer = parsed?.data?.viewer;
    const teams = parsed?.data?.teams?.nodes || [];
    if (!viewer?.id || !viewer?.name) {
      return {
        kind: "graphql_error",
        message: "Linear probe succeeded but viewer information was missing.",
        httpStatus: response.status,
        errorSummary,
      };
    }

    return {
      kind: "ok",
      message: "Linear probe succeeded.",
      httpStatus: response.status,
      viewer: {
        id: viewer.id,
        name: viewer.name,
      },
      teams,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: isNetworkErrorMessage(message) ? "network_error" : "http_error",
      message: isNetworkErrorMessage(message)
        ? "Linear probe failed with a network-level error."
        : "Linear probe failed before a usable response was returned.",
      errorSummary: summarizeText(message),
    };
  }
}

function effectiveApiKeySource(
  envKey: string | undefined,
  repoConfig: ConfigFileInfo,
  globalConfig: ConfigFileInfo
): string {
  if (envKey?.trim()) {
    return "environment variable (LINEAR_API_KEY)";
  }
  if (typeof repoConfig.data?.api_key === "string" && repoConfig.data.api_key.trim()) {
    return `repo config (${repoConfig.resolvedPath})`;
  }
  if (typeof globalConfig.data?.api_key === "string" && globalConfig.data.api_key.trim()) {
    return `global config (${globalConfig.resolvedPath})`;
  }
  return "not configured";
}

export const doctorCommand = new Command("doctor")
  .description("Diagnose Linear auth, connectivity, and remote sync state")
  .option("-j, --json", "Output as JSON")
  .option("--fix", "Attempt low-risk fixes for obvious issues")
  .action(async (options) => {
    const globalConfig = resolveConfigFile(getGlobalConfigPath());
    const repoConfig = resolveConfigFile(getRepoConfigPath());
    const config = getConfig();
    const envApiKey = process.env.LINEAR_API_KEY;
    const apiKey = typeof config.api_key === "string" ? config.api_key.trim() : "";
    const fixes: string[] = [];
    const repoWorkerPidFile = getPidFilePath();
    const repoWorkerPid = getWorkerPidFromFile();
    let workers = inspectWorkerProcesses();
    let zombieWorkers = workers.filter((worker) => worker.zombieCandidate);

    if (options.fix) {
      if (zombieWorkers.length > 0) {
        const reaped = await reapZombieWorkerProcesses(zombieWorkers);
        const reapedPids = reaped.filter((result) => result.success).map((result) => result.pid);
        if (reapedPids.length > 0) {
          fixes.push(`Terminated zombie worker process(es): ${reapedPids.join(", ")}.`);
        }
        workers = inspectWorkerProcesses();
        zombieWorkers = workers.filter((worker) => worker.zombieCandidate);
      }

      const globalApiKey =
        typeof globalConfig.data?.api_key === "string" ? globalConfig.data.api_key : undefined;
      if (globalApiKey && globalApiKey.trim() && globalApiKey.trim() !== globalApiKey) {
        const savedPath = writeGlobalConfig({ api_key: globalApiKey.trim() });
        fixes.push(`Trimmed surrounding whitespace from api_key in ${savedPath}.`);
        reloadConfig();
        resetGraphQLClient();
      }

      if (globalConfig.exists) {
        try {
          const mode = statSync(globalConfig.resolvedPath).mode & 0o777;
          if (mode !== 0o600) {
            chmodSync(globalConfig.resolvedPath, 0o600);
            fixes.push(`Normalized permissions on ${globalConfig.resolvedPath} to 0600.`);
          }
        } catch {
          // Best effort only.
        }
      }
    }

    const probe = await probeLinear(apiKey || envApiKey);
    let activePause = getActiveRemoteSyncPause();
    let backgroundPause = getAutomaticRemoteSyncPause();
    let activePauses = getActiveRemoteSyncPauses();
    let backgroundPauses = getAutomaticRemoteSyncPauses();

    if (options.fix && probe.kind === "ok" && (activePause || backgroundPause)) {
      clearRemoteSyncPause();
      fixes.push("Cleared stored remote sync pause after a successful Linear probe.");
      activePause = getActiveRemoteSyncPause();
      backgroundPause = getAutomaticRemoteSyncPause();
      activePauses = getActiveRemoteSyncPauses();
      backgroundPauses = getAutomaticRemoteSyncPauses();
    }

    const pendingOutbox = getPendingOutboxItems();
    const recentErrors = pendingOutbox
      .filter((item) => item.last_error)
      .slice(0, 5)
      .map((item) => ({
        operation: item.operation,
        subject: item.local_id || item.remote_issue_identifier || item.operation,
        error: summarizeText(item.last_error || ""),
      }));

    const policy = getLinearRequestPolicy();
    const doctorReport = {
      ok: probe.kind === "ok",
      environment: {
        cli_version: getRuntimeCliVersion(),
        bun_version: typeof Bun !== "undefined" ? Bun.version : undefined,
        node_compat_version: process.version,
        platform: process.platform,
        arch: process.arch,
        cwd: process.cwd(),
        issue_backend: getIssueBackendKind(),
        mail_backend: getMailBackendKind(),
        local_only: isLocalOnly(),
        human_output_style: getHumanOutputStyle(),
        linear_endpoint: LINEAR_ENDPOINT,
        linear_request_policy: policy,
        proxy_env: {
          HTTPS_PROXY: sanitizeProxyValue(process.env.HTTPS_PROXY),
          HTTP_PROXY: sanitizeProxyValue(process.env.HTTP_PROXY),
          NO_PROXY: process.env.NO_PROXY || null,
        },
      },
      config: {
        global_config: {
          path: globalConfig.resolvedPath,
          exists: globalConfig.exists,
        },
        repo_config: {
          path: repoConfig.resolvedPath,
          exists: repoConfig.exists,
        },
        api_key: {
          configured: Boolean(apiKey || envApiKey?.trim()),
          masked: maskKey(apiKey || envApiKey),
          source: effectiveApiKeySource(envApiKey, repoConfig, globalConfig),
        },
        team_key: config.team_key || null,
      },
      connectivity:
        probe.kind === "ok"
          ? {
              status: probe.kind,
              message: probe.message,
              http_status: probe.httpStatus,
              viewer: probe.viewer,
              teams: probe.teams,
            }
          : {
              status: probe.kind,
              message: probe.message,
              http_status: probe.httpStatus,
              error_summary: probe.errorSummary || null,
            },
      remote_sync: {
        active_pause: activePause
          ? {
              kind: activePause.kind,
              until: activePause.until,
              message: activePause.message || null,
            }
          : null,
        active_pauses: activePauses.map((pause) => ({
          kind: pause.kind,
          scope: pause.scope,
          until: pause.until,
          message: pause.message || null,
        })),
        background_pause: backgroundPause
          ? {
              kind: backgroundPause.kind,
              until: backgroundPause.backgroundUntil,
              message: backgroundPause.message || null,
            }
          : null,
        background_pauses: backgroundPauses.map((pause) => ({
          kind: pause.kind,
          scope: pause.scope,
          until: pause.backgroundUntil,
          message: pause.message || null,
        })),
      },
      workers: {
        repo_pid_file: {
          path: repoWorkerPidFile,
          pid: repoWorkerPid,
          alive: repoWorkerPid !== null ? isProcessAlive(repoWorkerPid) : false,
        },
        running: workers.map((worker) => ({
          pid: worker.pid,
          ppid: worker.ppid,
          elapsed: worker.elapsed,
          command: worker.command,
          cwd: worker.cwd,
          repo_pid_file: worker.repoPidFilePath,
          repo_pid: worker.repoPidFilePid,
          current_repo: worker.currentRepo,
          tracked_by_current_repo: worker.trackedByCurrentRepo,
          tracked_by_repo: worker.trackedByRepo,
          zombie_candidate: worker.zombieCandidate,
          zombie_reasons: worker.zombieReasons,
        })),
        zombie_candidates: zombieWorkers.map((worker) => ({
          pid: worker.pid,
          elapsed: worker.elapsed,
          command: worker.command,
          cwd: worker.cwd,
          repo_pid_file: worker.repoPidFilePath,
          repo_pid: worker.repoPidFilePid,
          reasons: worker.zombieReasons,
        })),
      },
      outbox: {
        pending_count: pendingOutbox.length,
        recent_errors: recentErrors,
      },
      fixes_applied: fixes,
    };

    if (options.json) {
      output(JSON.stringify(doctorReport, null, 2));
    } else {
      const lines: string[] = [];
      lines.push("lb doctor");
      lines.push("");
      lines.push("Environment");
      lines.push(`- lb version: ${doctorReport.environment.cli_version}`);
      if (doctorReport.environment.bun_version) {
        lines.push(`- bun version: ${doctorReport.environment.bun_version}`);
      }
      lines.push(
        `- platform: ${doctorReport.environment.platform} ${doctorReport.environment.arch}`
      );
      lines.push(`- cwd: ${doctorReport.environment.cwd}`);
      lines.push(
        `- backend: issues=${doctorReport.environment.issue_backend}, mail=${doctorReport.environment.mail_backend}, local_only=${doctorReport.environment.local_only}`
      );
      lines.push(`- output style: ${doctorReport.environment.human_output_style}`);
      lines.push(
        `- Linear request policy: timeout=${policy.timeoutMs}ms retries=${policy.maxRetries} base=${policy.retryBaseMs}ms jitter=${policy.jitterRatio}`
      );
      lines.push(
        `- proxy env: HTTPS_PROXY=${doctorReport.environment.proxy_env.HTTPS_PROXY || "unset"}, HTTP_PROXY=${doctorReport.environment.proxy_env.HTTP_PROXY || "unset"}, NO_PROXY=${doctorReport.environment.proxy_env.NO_PROXY || "unset"}`
      );
      lines.push("");
      lines.push("Configuration");
      lines.push(
        `- global config: ${doctorReport.config.global_config.path} (${doctorReport.config.global_config.exists ? "present" : "missing"})`
      );
      lines.push(
        `- repo config: ${doctorReport.config.repo_config.path} (${doctorReport.config.repo_config.exists ? "present" : "missing"})`
      );
      lines.push(
        `- api key: ${doctorReport.config.api_key.configured ? doctorReport.config.api_key.masked : "not configured"}`
      );
      lines.push(`- api key source: ${doctorReport.config.api_key.source}`);
      lines.push(`- team key: ${doctorReport.config.team_key || "auto-detected"}`);
      lines.push("");
      lines.push("Connectivity");
      lines.push(`- status: ${doctorReport.connectivity.status}`);
      lines.push(`- message: ${doctorReport.connectivity.message}`);
      if ("http_status" in doctorReport.connectivity && doctorReport.connectivity.http_status) {
        lines.push(`- HTTP status: ${doctorReport.connectivity.http_status}`);
      }
      if (doctorReport.connectivity.status === "ok") {
        lines.push(
          `- viewer: ${doctorReport.connectivity.viewer.name} (${doctorReport.connectivity.viewer.id})`
        );
        lines.push(
          `- teams: ${doctorReport.connectivity.teams.map((team) => `${team.name} (${team.key})`).join(", ")}`
        );
      } else if (doctorReport.connectivity.error_summary) {
        lines.push(`- details: ${doctorReport.connectivity.error_summary}`);
      }
      lines.push("");
      lines.push("Remote sync");
      if (doctorReport.remote_sync.active_pause) {
        lines.push(
          `- active pause: ${doctorReport.remote_sync.active_pause.kind} until ${doctorReport.remote_sync.active_pause.until}`
        );
        if (doctorReport.remote_sync.active_pause.message) {
          lines.push(`- active pause details: ${doctorReport.remote_sync.active_pause.message}`);
        }
      } else {
        lines.push("- active pause: none");
      }
      if (doctorReport.remote_sync.active_pauses.length > 0) {
        for (const pause of doctorReport.remote_sync.active_pauses) {
          const scopeLabel =
            pause.scope.kind === "endpoint"
              ? `endpoint:${pause.scope.endpointName}`
              : pause.scope.kind;
          lines.push(`- active scope: ${scopeLabel} (${pause.kind}) until ${pause.until}`);
        }
      }
      if (doctorReport.remote_sync.background_pause) {
        lines.push(
          `- background pause: ${doctorReport.remote_sync.background_pause.kind} until ${doctorReport.remote_sync.background_pause.until}`
        );
      } else {
        lines.push("- background pause: none");
      }
      if (doctorReport.remote_sync.background_pauses.length > 0) {
        for (const pause of doctorReport.remote_sync.background_pauses) {
          const scopeLabel =
            pause.scope.kind === "endpoint"
              ? `endpoint:${pause.scope.endpointName}`
              : pause.scope.kind;
          lines.push(`- background scope: ${scopeLabel} (${pause.kind}) until ${pause.until}`);
        }
      }
      lines.push("");
      lines.push("Outbox");
      lines.push(`- pending items: ${doctorReport.outbox.pending_count}`);
      if (doctorReport.outbox.recent_errors.length > 0) {
        for (const entry of doctorReport.outbox.recent_errors) {
          lines.push(`- ${entry.subject}: ${entry.error}`);
        }
      } else {
        lines.push("- recent errors: none");
      }
      lines.push("");
      lines.push("Workers");
      lines.push(
        `- repo pid file: ${doctorReport.workers.repo_pid_file.path} (${doctorReport.workers.repo_pid_file.pid ? `pid ${doctorReport.workers.repo_pid_file.pid}` : "no pid"})`
      );
      if (doctorReport.workers.running.length > 0) {
        for (const worker of doctorReport.workers.running) {
          const workerBits = [
            `pid ${worker.pid}`,
            worker.elapsed,
            worker.current_repo ? "current-repo" : "other-repo",
            worker.tracked_by_repo ? "repo-tracked" : "repo-untracked",
            worker.zombie_candidate ? `zombie:${worker.zombie_reasons.join(",")}` : "ok",
          ];
          lines.push(`- worker: ${workerBits.join(" | ")}`);
          lines.push(`- worker cwd: ${worker.cwd || "unknown"}`);
          if (worker.repo_pid_file) {
            lines.push(
              `- worker repo pid file: ${worker.repo_pid_file} (${worker.repo_pid ? `pid ${worker.repo_pid}` : "no pid"})`
            );
          }
          lines.push(`- worker cmd: ${summarizeText(worker.command, 160)}`);
        }
      } else {
        lines.push("- running workers: none");
      }
      if (doctorReport.fixes_applied.length > 0) {
        lines.push("");
        lines.push("Fixes applied");
        for (const fix of doctorReport.fixes_applied) {
          lines.push(`- ${fix}`);
        }
      }

      output(lines.join("\n"));
    }

    if (probe.kind !== "ok") {
      process.exitCode = 1;
    }
  });
