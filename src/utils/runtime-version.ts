import packageJson from "../../package.json";
import { normalizeReleaseTag } from "./release-version.js";

const FALLBACK_CLI_VERSION = "v0";

/**
 * Canonical runtime version for this lb binary.
 * Bun compile embeds package.json content at build time, so this stays stable
 * regardless of where the binary is installed.
 */
export function getRuntimeCliVersion(): string {
  const rawVersion = packageJson.version;
  if (typeof rawVersion !== "string" || rawVersion.trim().length === 0) {
    return FALLBACK_CLI_VERSION;
  }

  const trimmed = rawVersion.trim();
  const withPrefix = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  return normalizeReleaseTag(withPrefix);
}
