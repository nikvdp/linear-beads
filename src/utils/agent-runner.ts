import { spawn } from "child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "fs";
import { dirname, join } from "path";
import type { AgentRun, Issue } from "../types.js";
import {
  getAutoAgentTemplate,
  getAutoPromptTemplate,
  getDbPath,
} from "./config.js";
import {
  createAgentRun,
  getCurrentAgentHandle,
  resolveIssueLocalId,
} from "./database.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (_placeholder, name: string) => {
    if (!(name in variables)) {
      throw new Error(`Unknown template placeholder: {${name}}`);
    }
    return shellQuote(variables[name]);
  });
}

type AgentInvocationOptions = {
  issue: Issue;
  runId: string;
  workdir: string;
  logPath: string;
  agentName: string;
};

export function buildAgentInvocation(options: AgentInvocationOptions): string {
  const commandTemplate = getAutoAgentTemplate(options.agentName);
  if (!commandTemplate) {
    throw new Error(
      `No auto_agents command template is configured for agent '${options.agentName}'.`
    );
  }

  const ticketId = options.issue.linear_identifier || options.issue.id;
  const prompt = renderTemplate(getAutoPromptTemplate(), {
    ticket_id: ticketId,
    workdir: options.workdir,
    log_file: options.logPath,
    run_id: options.runId,
  });
  return renderTemplate(commandTemplate, {
    prompt,
    workdir: options.workdir,
    log_file: options.logPath,
    ticket_id: ticketId,
  });
}

export function spawnAgentRun(
  options: AgentInvocationOptions & { worker?: string }
): AgentRun {
  const runsDir = join(dirname(getDbPath()), "runs");
  mkdirSync(runsDir, { recursive: true });

  const invocation = buildAgentInvocation(options);
  const ticketId = options.issue.linear_identifier || options.issue.id;
  const logFd = openSync(options.logPath, "a");
  writeSync(
    logFd,
    `run ${options.runId} / ${ticketId} / ${options.agentName} / ${new Date().toISOString()}\n`
  );

  const child = (() => {
    try {
      const spawned = spawn("/bin/sh", ["-c", invocation], {
        cwd: options.workdir,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: options.worker ? { ...process.env, LB_WORKER: options.worker } : process.env,
      });
      spawned.unref();
      return spawned;
    } finally {
      closeSync(logFd);
    }
  })();

  return createAgentRun({
    id: options.runId,
    issue_id: options.issue.local_id || resolveIssueLocalId(options.issue.id),
    agent_name: options.agentName,
    agent_handle: getCurrentAgentHandle() || undefined,
    pid: child.pid,
    log_path: options.logPath,
    workdir: options.workdir,
  });
}
