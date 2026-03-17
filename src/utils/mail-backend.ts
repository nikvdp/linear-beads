import type { MailBackendAdapter } from "../adapters/types.js";
import { linearMailBackend } from "../adapters/linear-mail.js";
import { getMailBackendKind, isLocalOnly } from "./config.js";
import { getAutomaticRemoteSyncPause } from "./remote-sync-state.js";

const localMailBackend: MailBackendAdapter = {
  name: "local",
  async send(): Promise<void> {
    // Local mode keeps mail canonical in SQLite only.
  },
  async reply(): Promise<void> {
    // Local mode keeps mail canonical in SQLite only.
  },
  async markRead(): Promise<void> {
    // Local mode keeps mail canonical in SQLite only.
  },
  async ack(): Promise<void> {
    // Local mode keeps mail canonical in SQLite only.
  },
  async ingest(): Promise<{ inserted: number; skipped: number; cursor: string | null }> {
    return { inserted: 0, skipped: 0, cursor: null };
  },
};

export function getMailBackendAdapter(): MailBackendAdapter {
  if (isLocalOnly() || getAutomaticRemoteSyncPause()) {
    return localMailBackend;
  }

  return getMailBackendKind() === "linear" ? linearMailBackend : localMailBackend;
}
