import type { MailBackendAdapter } from "../adapters/types.js";
import { getMailBackendKind, isLocalOnly } from "./config.js";

const localMailBackend: MailBackendAdapter = {
  name: "local",
};

const linearMailBackend: MailBackendAdapter = {
  name: "linear",
};

export function getMailBackendAdapter(): MailBackendAdapter {
  if (isLocalOnly()) {
    return localMailBackend;
  }

  return getMailBackendKind() === "linear" ? linearMailBackend : localMailBackend;
}
