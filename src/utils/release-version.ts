export type ReleaseVersionParts = {
  major: number;
  minor: number;
  patch: number;
};

const RELEASE_VERSION_RE = /^\d+\.\d+\.\d+$/;

export function parseReleaseVersion(raw: string): ReleaseVersionParts {
  if (!RELEASE_VERSION_RE.test(raw)) {
    throw new Error(`Invalid release version: ${raw}`);
  }

  const [majorString, minorString, patchString] = raw.split(".");
  const major = Number(majorString);
  const minor = Number(minorString);
  const patch = Number(patchString);

  if (
    Number.isNaN(major) ||
    Number.isNaN(minor) ||
    Number.isNaN(patch) ||
    major < 0 ||
    minor < 0 ||
    patch < 0
  ) {
    throw new Error(`Invalid release version: ${raw}`);
  }

  return { major, minor, patch };
}

export function formatReleaseVersion(parts: ReleaseVersionParts): string {
  return `${parts.major}.${parts.minor}.${parts.patch}`;
}

export function parseReleaseTag(tag: string): number | undefined {
  const trimmed = tag.trim();
  const match = /^v(\d+)$/.exec(trimmed);
  if (!match) {
    return undefined;
  }

  return Number(match[1]);
}

export function releaseTag(patch: number): string {
  return `v${patch}`;
}
