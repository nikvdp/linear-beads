/**
 * lb import - Import issues from beads to Linear
 */

import { Command } from "commander";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { getDbPath } from "../utils/config.js";
import { getTeamId } from "../utils/linear.js";
import { output } from "../utils/output.js";
import {
  parseBeadsJsonl,
  filterIssues,
  checkDuplicates,
  createImportedIssues,
  createImportedDependencies,
  saveImportMapping,
  type ImportOptions,
} from "../utils/import-beads.js";

export const importCommand = new Command("import")
  .description("Import issues from beads (.beads/issues.jsonl)")
  .option("--source <path>", "Path to beads JSONL file", ".beads/issues.jsonl")
  .option("--dry-run", "Preview import without creating issues")
  .option("--include-closed", "Import closed issues (default: skip)")
  .option("--since <date>", "Only import issues created after this date")
  .option("--force", "Skip confirmation prompt")
  .action(async (options) => {
    try {
      const sourcePath = options.source;

      output("Importing from " + sourcePath + "...\n");

      // Check if beads file exists
      if (!existsSync(sourcePath)) {
        output(`Error: Beads file not found: ${sourcePath}`);
        output("\nMake sure you're in a beads project directory or use --source flag");
        process.exit(1);
      }

      // Parse beads JSONL
      const allIssues = parseBeadsJsonl(sourcePath);
      const openCount = allIssues.filter((i) => i.status !== "closed").length;
      const closedCount = allIssues.length - openCount;

      output(`Found ${allIssues.length} issues (${openCount} open, ${closedCount} closed)\n`);

      // Build import options
      const importOptions: ImportOptions = {
        includeClosed: options.includeClosed,
        since: options.since ? new Date(options.since) : undefined,
      };

      // Filter issues
      const filtered = filterIssues(allIssues, importOptions);

      if (filtered.length < allIssues.length) {
        output("Filtering:");
        if (!options.includeClosed && closedCount > 0) {
          output(`- Skipping ${closedCount} closed issues (use --include-closed to import)`);
        }
        if (options.since) {
          output(`- Filtered by date: --since ${options.since}`);
        }
        output(`- Importing ${filtered.length} issues\n`);
      }

      if (filtered.length === 0) {
        output("No issues to import after filtering.");
        return;
      }

      // Check for duplicates
      output("Checking for duplicates...");
      const teamId = await getTeamId();
      const duplicates = await checkDuplicates(filtered, teamId);

      if (duplicates.size > 0) {
        output(`- Found ${duplicates.size} duplicates (will skip)\n`);
        for (const [beadsId, linearId] of duplicates.entries()) {
          const issue = filtered.find((i) => i.id === beadsId);
          if (issue) {
            output(`  ${beadsId} → ${linearId}: "${issue.title}" (exists)`);
          }
        }
        output("");
      } else {
        output("- No duplicates found\n");
      }

      // Filter out duplicates
      const toImport = filtered.filter((i) => !duplicates.has(i.id));

      if (toImport.length === 0) {
        output("All issues already exist in Linear. Nothing to import.");
        return;
      }

      // Dry run - just show what would be imported
      if (options.dryRun) {
        output(`\nDry run: Would import ${toImport.length} issues:\n`);
        for (const issue of toImport) {
          const typeStr = issue.issue_type ? `, ${issue.issue_type}` : "";
          output(
            `- ${issue.id}: "${issue.title}" (${issue.status}${typeStr}, priority ${issue.priority})`
          );
        }
        output("\nRun without --dry-run to proceed");
        return;
      }

      // Confirmation
      if (!options.force) {
        output(`Ready to import ${toImport.length} issues to Linear.`);
        output("Press Ctrl+C to cancel, or Enter to continue...");
        await new Promise((resolve) => {
          process.stdin.once("data", resolve);
        });
        output("");
      }

      // Import issues
      output("Creating issues...");
      const mapping = await createImportedIssues(toImport, teamId);
      output("");

      if (mapping.size === 0) {
        output("Failed to import any issues.");
        process.exit(1);
      }

      // Import dependencies
      if (toImport.some((i) => i.dependencies || i.parent)) {
        output("Creating dependencies...");
        await createImportedDependencies(toImport, mapping, teamId);
        output("");
      }

      // Save mapping
      const dbPath = getDbPath();
      const lbDir = dirname(dbPath);
      const mappingPath = join(lbDir, "import-map.jsonl");
      saveImportMapping(mapping, mappingPath);

      // Summary
      output("Import complete!");
      output(`- ${mapping.size} issues created`);
      if (duplicates.size > 0) {
        output(`- ${duplicates.size} skipped (duplicates)`);
      }
      output(`- Mapping saved to ${mappingPath}`);
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
