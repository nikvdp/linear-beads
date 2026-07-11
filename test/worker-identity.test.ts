import { afterEach, describe, expect, test } from "bun:test";
import { setRuntimeOverrides } from "../src/utils/config.js";
import {
  describeWorkerResolution,
  resolveWorkerName,
  workerLabelName,
} from "../src/utils/worker-identity.js";

const originalWorker = process.env.LB_WORKER;

afterEach(() => {
  if (originalWorker === undefined) {
    delete process.env.LB_WORKER;
  } else {
    process.env.LB_WORKER = originalWorker;
  }
  setRuntimeOverrides({ auto_label: "auto" });
});

describe("worker identity", () => {
  test("prefers the flag over the environment", () => {
    process.env.LB_WORKER = "env-worker";
    expect(describeWorkerResolution("flag-worker")).toEqual({
      worker: "flag-worker",
      source: "flag",
    });
  });

  test("uses a trimmed environment value when no flag is present", () => {
    process.env.LB_WORKER = "  env-worker  ";
    expect(describeWorkerResolution()).toEqual({ worker: "env-worker", source: "env" });
  });

  test("returns no identity for empty inputs", () => {
    process.env.LB_WORKER = "  ";
    expect(resolveWorkerName("")).toBeUndefined();
    expect(describeWorkerResolution()).toEqual({ worker: undefined, source: "none" });
  });

  test("rejects names that are not safe lowercase label segments", () => {
    delete process.env.LB_WORKER;
    for (const invalid of ["Uppercase", "two words", "-leading"]) {
      expect(() => resolveWorkerName(invalid)).toThrow(`Invalid worker name '${invalid}'`);
    }
  });

  test("derives the label family from auto_label", () => {
    expect(workerLabelName("codex-a")).toBe("auto:codex-a");
    setRuntimeOverrides({ auto_label: "dispatch" });
    expect(workerLabelName("codex-a")).toBe("dispatch:codex-a");
  });
});
