import { readFile } from "node:fs/promises";

type DescriptionInputOptions = {
  inlineDescription?: string;
  descriptionFile?: string;
  descriptionStdin?: boolean;
};

function countEnabledSources(options: DescriptionInputOptions): number {
  let count = 0;
  if (options.inlineDescription !== undefined) count += 1;
  if (options.descriptionFile) count += 1;
  if (options.descriptionStdin) count += 1;
  return count;
}

async function readDescriptionFromStdin(): Promise<string> {
  let out = "";
  for await (const chunk of process.stdin) {
    out += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return out;
}

export async function resolveDescriptionInput(
  options: DescriptionInputOptions
): Promise<string | undefined> {
  const sourceCount = countEnabledSources(options);
  if (sourceCount > 1) {
    throw new Error(
      "Description input conflict: choose only one of --description, --description-file, or --description-stdin"
    );
  }

  if (options.descriptionFile) {
    return await readFile(options.descriptionFile, "utf8");
  }

  if (options.descriptionStdin) {
    return await readDescriptionFromStdin();
  }

  return options.inlineDescription;
}

export function looksLikeEscapedNewlineMistake(description: string | undefined): boolean {
  if (!description || !description.includes("\\n")) return false;

  const escapedNewlineCount = (description.match(/\\n/g) || []).length;
  if (escapedNewlineCount >= 2) return true;

  if (/\\n\\n/.test(description)) return true;
  if (/\\n[-*]\s/.test(description)) return true;
  if (/:\s*\\n/.test(description)) return true;

  return false;
}

export function rewriteEscapedNewlines(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  return description.replace(/\\n/g, "\n");
}
