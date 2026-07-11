import { Command } from "commander";
import { output, outputError } from "../utils/output.js";
import { describeWorkerResolution, workerLabelName } from "../utils/worker-identity.js";

export const workerCommand = new Command("worker").description(
  "Inspect ephemeral auto-mode worker identity"
);

workerCommand
  .command("whoami")
  .description("Show the worker identity and targeted label for this session")
  .option("--worker <name>", "Worker name (overrides LB_WORKER)")
  .option("-j, --json", "Output as JSON")
  .action((options) => {
    try {
      const resolution = describeWorkerResolution(options.worker);
      const label = resolution.worker ? workerLabelName(resolution.worker) : undefined;

      if (options.json) {
        output(JSON.stringify({ ...resolution, label }, null, 2));
      } else if (!resolution.worker) {
        output("no worker identity (generic) — pass --worker or set LB_WORKER");
      } else {
        const source = resolution.source === "flag" ? "--worker" : "LB_WORKER";
        output(`${resolution.worker} (from ${source}) — watching label ${label}`);
      }
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
