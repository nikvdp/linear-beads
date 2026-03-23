import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REMOTE_SYNC_STATE_PATH = join(import.meta.dir, "..", "src", "utils", "remote-sync-state.ts");
const OUTBOX_PROCESSOR_PATH = join(import.meta.dir, "..", "src", "utils", "outbox-processor.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-upload-pause-"));
  tempDirs.push(repoDir);

  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (init.exitCode !== 0) {
    throw new Error("Failed to initialize git repo");
  }

  mkdirSync(join(repoDir, ".lb"), { recursive: true });
  writeFileSync(join(repoDir, ".lb", "config.jsonc"), "{}\n");
  return repoDir;
}

async function runEval(
  cwd: string,
  script: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "--eval", script], {
    cwd,
    env: {
      ...process.env,
      LINEAR_API_KEY: "linear-test-key",
      LB_TEAM_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("upload pause isolation", () => {
  test("scopes media upload network pauses to the uploads endpoint", async () => {
    const repoDir = createRepo();
    const script = `
      import {
        clearRemoteSyncPause,
        getAutomaticRemoteSyncPause,
        getAutomaticRemoteSyncPauseForEndpoints,
        recordRemoteSyncPause,
      } from ${JSON.stringify(REMOTE_SYNC_STATE_PATH)};

      clearRemoteSyncPause();
      const pause = recordRemoteSyncPause(
        new Error(
          "Linear media upload network error for 'm_upload001' (endpointName=uploads, host=uploads.linear.app): Unable to connect. Is the computer able to access the url?"
        )
      );

      console.log(
        JSON.stringify({
          pauseScope: pause?.scope || null,
          firstPauseScope: getAutomaticRemoteSyncPause()?.scope || null,
          uploadsPaused: Boolean(getAutomaticRemoteSyncPauseForEndpoints(["uploads"])),
          createPaused: Boolean(getAutomaticRemoteSyncPauseForEndpoints(["issueCreate"])),
        })
      );
    `;

    const result = await runEval(repoDir, script);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      pauseScope: { kind: string; endpointName?: string } | null;
      firstPauseScope: { kind: string; endpointName?: string } | null;
      uploadsPaused: boolean;
      createPaused: boolean;
    };

    expect(payload.pauseScope).toEqual({ kind: "endpoint", endpointName: "uploads" });
    expect(payload.firstPauseScope).toEqual({ kind: "endpoint", endpointName: "uploads" });
    expect(payload.uploadsPaused).toBe(true);
    expect(payload.createPaused).toBe(false);
  });

  test("only media-bearing outbox rows advertise the uploads endpoint", async () => {
    const repoDir = createRepo();
    const script = `
      import { getOutboxItemEndpointNames } from ${JSON.stringify(OUTBOX_PROCESSOR_PATH)};

      const plainCreate = {
        id: 1,
        operation: "create",
        payload: { title: "Plain", priority: 2, description: "Body" },
        local_id: "LOCAL-1",
        created_at: new Date().toISOString(),
        retry_count: 0,
      };
      const mediaCreate = {
        id: 2,
        operation: "create",
        payload: {
          title: "Media",
          priority: 2,
          description: "See ![shot](lb-media:m_upload001)",
        },
        local_id: "LOCAL-2",
        created_at: new Date().toISOString(),
        retry_count: 0,
      };

      console.log(
        JSON.stringify({
          plain: getOutboxItemEndpointNames(plainCreate),
          media: getOutboxItemEndpointNames(mediaCreate),
        })
      );
    `;

    const result = await runEval(repoDir, script);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      plain: string[];
      media: string[];
    };

    expect(payload.plain).not.toContain("uploads");
    expect(payload.media).toContain("uploads");
  });
});
