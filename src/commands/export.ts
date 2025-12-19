/**
 * lb export - Export issues to JSONL (beads-compatible)
 */

import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { createHash } from "crypto";
import { getDbPath } from "../utils/config.js";
import { getCachedIssues, getDependencies } from "../utils/database.js";
import type { Dependency } from "../types.js";

type Format = "beads";

interface ImportMapEntry {
  beads_id: string;
  linear_id: string;
}

function loadImportMap(): Map<string, string> {
  const dbPath = getDbPath();
  const lbDir = dirname(dbPath);
  const mapPath = join(lbDir, "import-map.jsonl");

  const map = new Map<string, string>();

  if (!existsSync(mapPath)) return map;

  const content = readFileSync(mapPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ImportMapEntry;
      if (parsed.linear_id && parsed.beads_id) {
        map.set(parsed.linear_id, parsed.beads_id);
      }
    } catch {
      // Ignore malformed lines
    }
  }

  return map;
}

function hashToBeadsId(linearId: string): string {
  const hash = createHash("sha1").update(linearId).digest("hex").slice(0, 8);
  return `bd-${hash}`;
}

function buildIdMapper(importMap: Map<string, string>): (linearId: string) => string {
  const cache = new Map<string, string>();

  return (linearId: string): string => {
    if (cache.has(linearId)) return cache.get(linearId)!;
    if (importMap.has(linearId)) {
      const mapped = importMap.get(linearId)!;
      cache.set(linearId, mapped);
      return mapped;
    }
    if (linearId.startsWith("bd-")) {
      cache.set(linearId, linearId);
      return linearId;
    }
    const generated = hashToBeadsId(linearId);
    cache.set(linearId, generated);
    return generated;
  };
}

function toBeadsDependencies(
  deps: Dependency[],
  mapId: (id: string) => string
): Dependency[] {
  return deps.map((dep) => ({
    ...dep,
    issue_id: mapId(dep.issue_id),
    depends_on_id: mapId(dep.depends_on_id),
  }));
}

function deriveParentId(deps: Dependency[], mapId: (id: string) => string): string | undefined {
  const parentDep = deps.find((d) => d.type === "parent-child");
  if (!parentDep) return undefined;
  return mapId(parentDep.depends_on_id);
}

export const exportCommand = new Command("export")
  .description("Export issues to JSONL (default: beads-compatible)")
  .argument("[output]", "Output file path", ".lb/issues.jsonl")
  .option("--format <format>", "Export format", "beads")
  .action(async (output: string, options) => {
    const format = (options.format || "beads") as Format;
    if (format !== "beads") {
      console.error(`Unsupported format: ${format}`);
      process.exit(1);
    }

    try {
      const dbPath = getDbPath();
      const outputPath = output.startsWith("/") ? output : join(process.cwd(), output);
      const outputDir = dirname(outputPath);

      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      const importMap = loadImportMap();
      const mapId = buildIdMapper(importMap);

      const issues = getCachedIssues();

      // Precompute IDs for all issues to keep dependencies stable
      const idMap = new Map<string, string>();
      for (const issue of issues) {
        idMap.set(issue.id, mapId(issue.id));
      }

      const lines: string[] = [];

      for (const issue of issues) {
        const deps = toBeadsDependencies(getDependencies(issue.id), (id) => {
          if (idMap.has(id)) return idMap.get(id)!;
          const mapped = mapId(id);
          idMap.set(id, mapped);
          return mapped;
        });

        const parent = deriveParentId(deps, (id) => idMap.get(id) || mapId(id));

        const beadsIssue: Record<string, unknown> = {
          id: idMap.get(issue.id)!,
          title: issue.title,
          status: issue.status,
          priority: issue.priority,
          created_at: issue.created_at,
          updated_at: issue.updated_at,
        };

        if (issue.description) beadsIssue.description = issue.description;
        beadsIssue.issue_type = issue.issue_type || "task";
        if (issue.closed_at) beadsIssue.closed_at = issue.closed_at;
        if (parent) beadsIssue.parent = parent;
        if (deps.length > 0) beadsIssue.dependencies = deps;

        lines.push(JSON.stringify(beadsIssue));
      }

      // Stable ordering by ID for diff friendliness
      lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      const tmpPath = `${outputPath}.tmp`;
      writeFileSync(tmpPath, lines.join("\n") + "\n");
      renameSync(tmpPath, outputPath);

      console.log(`Exported ${issues.length} issues to ${outputPath} (format: ${format}).`);
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
