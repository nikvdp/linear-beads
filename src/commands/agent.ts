import { Command } from "commander";
import {
  isLinearMailDirectoryConfigured,
  publishLinearMailAgentIdentity,
  refreshLinearMailAgentDirectory,
} from "../adapters/linear-mail.js";
import {
  getAgentByHandle,
  getCurrentAgentHandle,
  listAgents,
  registerAgent,
  setCurrentAgentHandle,
} from "../utils/database.js";
import { output, outputError } from "../utils/output.js";

export const agentCommand = new Command("agent").description("Manage local agent identities");

agentCommand
  .command("register")
  .description("Register a local agent identity")
  .option("--name <displayName>", "Display name")
  .option("--handle <preferred>", "Preferred handle")
  .option("--pubkey <pubkey>", "Optional public key")
  .option("-j, --json", "Output as JSON")
  .action(async (options) => {
    try {
      const agent = registerAgent({
        preferredHandle: options.handle,
        displayName: options.name,
        pubkey: options.pubkey,
      });
      if (isLinearMailDirectoryConfigured()) {
        await publishLinearMailAgentIdentity(agent);
      }
      setCurrentAgentHandle(agent.handle);

      if (options.json) {
        output(JSON.stringify(agent, null, 2));
      } else {
        output(`Registered agent: ${agent.handle} (${agent.id})`);
      }
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

agentCommand
  .command("whoami")
  .description("Show the current local agent identity")
  .option("-j, --json", "Output as JSON")
  .action((options) => {
    const handle = getCurrentAgentHandle();
    if (!handle) {
      outputError("No current agent selected. Run `lb agent register` first.");
      process.exit(1);
    }

    const agent = getAgentByHandle(handle);
    if (!agent) {
      outputError(`Current agent handle '${handle}' no longer exists. Register a new agent.`);
      process.exit(1);
    }

    if (options.json) {
      output(JSON.stringify(agent, null, 2));
    } else {
      output(`${agent.handle} (${agent.id})`);
    }
  });

agentCommand
  .command("list")
  .description("List local agent identities")
  .option("-j, --json", "Output as JSON")
  .action(async (options) => {
    if (isLinearMailDirectoryConfigured()) {
      await refreshLinearMailAgentDirectory();
    }

    const agents = listAgents();

    if (options.json) {
      output(JSON.stringify(agents, null, 2));
      return;
    }

    if (agents.length === 0) {
      output("No agents registered.");
      return;
    }

    for (const agent of agents) {
      const display = agent.display_name ? ` ${agent.display_name}` : "";
      output(`${agent.handle}${display} (${agent.id})`);
    }
  });
