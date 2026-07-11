import { getAutoLabel } from "./config.js";

const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function normalizeWorkerName(value: string | undefined): string | undefined {
  const worker = value?.trim();
  if (!worker) return undefined;
  if (!WORKER_NAME_PATTERN.test(worker)) {
    throw new Error(
      `Invalid worker name '${worker}': expected lowercase letters, numbers, dots, underscores, or dashes, starting with a letter or number.`
    );
  }
  return worker;
}

export function describeWorkerResolution(cliValue?: string): {
  worker: string | undefined;
  source: "flag" | "env" | "none";
} {
  const fromFlag = normalizeWorkerName(cliValue);
  if (fromFlag) return { worker: fromFlag, source: "flag" };

  const fromEnv = normalizeWorkerName(process.env.LB_WORKER);
  if (fromEnv) return { worker: fromEnv, source: "env" };

  return { worker: undefined, source: "none" };
}

export function resolveWorkerName(cliValue?: string): string | undefined {
  return describeWorkerResolution(cliValue).worker;
}

export function workerLabelName(worker: string): string {
  const normalized = normalizeWorkerName(worker);
  if (!normalized) throw new Error("Worker name is required to build a worker label.");
  return `${getAutoLabel()}:${normalized}`;
}
