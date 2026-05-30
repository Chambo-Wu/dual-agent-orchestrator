#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const REQUIRED_HEADINGS = ["Core Procedure", "Scenario Extensions", "Appendix"];

function parseArgs(argv) {
  const options = {
    json: false,
    warnOnly: false,
    root: "skills",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--warn-only") {
      options.warnOnly = true;
    } else if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--root requires a path");
      }
      options.root = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/check-skill-markdown-structure.mjs [options]

Options:
  --json        Output JSON inventory only.
  --warn-only   Always exit 0 while still reporting issues.
  --root <dir>  Scan a different skill root. Defaults to skills.
  -h, --help    Show this help text.
`);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function relativePath(rootDir, targetPath) {
  return toPosixPath(path.relative(rootDir, targetPath));
}

function extractHeadingName(line) {
  const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  return match ? match[2].trim() : null;
}

function parseMarkdownSections(markdown) {
  const sections = new Map();
  const headings = [];
  let currentHeading = null;
  let currentLines = [];

  for (const line of markdown.split(/\r?\n/)) {
    const headingName = extractHeadingName(line);
    if (headingName) {
      if (currentHeading) {
        sections.set(currentHeading, currentLines.join("\n"));
      }
      currentHeading = headingName;
      headings.push(headingName);
      currentLines = [];
    } else if (currentHeading) {
      currentLines.push(line);
    }
  }

  if (currentHeading) {
    sections.set(currentHeading, currentLines.join("\n"));
  }

  return { headings, sections };
}

function sectionHasContent(content) {
  return content
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .some((line) => line.trim().length > 0);
}

function nonStandardHeadings(headings) {
  return headings.filter((heading) => {
    if (REQUIRED_HEADINGS.includes(heading)) {
      return false;
    }
    const normalized = heading.toLowerCase();
    return (
      normalized.includes("procedure") ||
      normalized.includes("workflow") ||
      normalized.includes("scenario") ||
      normalized.includes("appendix") ||
      normalized.includes("pitfall") ||
      normalized.includes("verification")
    );
  });
}

function riskTierHint(manifest) {
  const requiredTools = Array.isArray(manifest?.requiredTools) ? manifest.requiredTools : [];
  const toolNames = requiredTools.map((tool) => String(tool).toLowerCase());
  const hasShell = toolNames.some((tool) => tool.includes("shell") || tool.includes("write"));
  const hasNetwork = toolNames.some((tool) => tool.includes("web") || tool.includes("fetch"));

  if (hasShell) {
    return "medium";
  }
  if (hasNetwork) {
    return "low";
  }
  return "low";
}

async function readManifest(manifestPath) {
  const content = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(content);
}

async function inspectSkillDir(rootDir, skillDirPath) {
  const manifestPath = path.join(skillDirPath, "skill.json");
  const markdownPath = path.join(skillDirPath, "SKILL.md");
  const manifestExists = await pathExists(manifestPath);
  const markdownExists = await pathExists(markdownPath);
  const skillDir = relativePath(rootDir, skillDirPath);
  const notes = [];
  const errors = [];
  let manifest = {};
  let manifestReadable = true;

  if (manifestExists) {
    try {
      manifest = await readManifest(manifestPath);
    } catch (error) {
      manifestReadable = false;
      errors.push(`Cannot parse ${relativePath(rootDir, manifestPath)}: ${error.message}`);
      notes.push("manifest_parse_failed");
    }
  } else {
    manifestReadable = false;
    notes.push("manifest_missing");
  }

  const skillId = typeof manifest.id === "string" && manifest.id.trim() ? manifest.id : path.basename(skillDirPath);
  const record = {
    skillId,
    skillDir,
    manifestPath: manifestExists ? relativePath(rootDir, manifestPath) : null,
    markdownPath: markdownExists ? relativePath(rootDir, markdownPath) : null,
    manifestExists,
    markdownExists,
    status: "missing",
    riskTierHint: riskTierHint(manifest),
    intents: Array.isArray(manifest.intents) ? manifest.intents : [],
    requiredTools: Array.isArray(manifest.requiredTools) ? manifest.requiredTools : [],
    executionStrategy:
      manifest.execution && typeof manifest.execution.strategy === "string" ? manifest.execution.strategy : null,
    hasCoreProcedure: false,
    hasScenarioExtensions: false,
    hasAppendix: false,
    emptySections: [],
    nonStandardHeadings: [],
    manifestMarkdownDriftHints: [],
    recommendedAction: "scaffold",
    notes,
  };

  if (!manifestReadable) {
    return { record, errors };
  }

  if (!markdownExists) {
    record.notes.push("SKILL.md is missing");
    return { record, errors };
  }

  let markdown = "";
  try {
    markdown = await fs.readFile(markdownPath, "utf8");
  } catch (error) {
    record.notes.push(`SKILL.md_read_failed: ${error.message}`);
    return { record, errors };
  }

  if (!markdown.trim()) {
    record.notes.push("SKILL.md is empty");
    return { record, errors };
  }

  const { headings, sections } = parseMarkdownSections(markdown);
  record.hasCoreProcedure = sections.has("Core Procedure");
  record.hasScenarioExtensions = sections.has("Scenario Extensions");
  record.hasAppendix = sections.has("Appendix");
  record.emptySections = REQUIRED_HEADINGS.filter((heading) => sections.has(heading) && !sectionHasContent(sections.get(heading)));
  record.nonStandardHeadings = nonStandardHeadings(headings);

  const missingHeadings = REQUIRED_HEADINGS.filter((heading) => !sections.has(heading));
  if (missingHeadings.length === 0 && record.emptySections.length === 0) {
    record.status = "compliant";
    record.recommendedAction = "none";
    record.notes.push("standard headings present");
  } else {
    record.status = "partial";
    record.recommendedAction = "restructure";
    if (missingHeadings.length > 0) {
      record.notes.push(`missing headings: ${missingHeadings.join(", ")}`);
    }
    if (record.emptySections.length > 0) {
      record.notes.push(`empty sections: ${record.emptySections.join(", ")}`);
    }
  }

  return { record, errors };
}

async function discoverSkillDirs(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const dirs = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillDirPath = path.join(rootDir, entry.name);
    const manifestExists = await pathExists(path.join(skillDirPath, "skill.json"));
    const markdownExists = await pathExists(path.join(skillDirPath, "SKILL.md"));
    if (manifestExists || markdownExists) {
      dirs.push(skillDirPath);
    }
  }

  return dirs.sort((left, right) => left.localeCompare(right));
}

function summarize(records, toolErrors) {
  return {
    total: records.length,
    compliant: records.filter((record) => record.status === "compliant").length,
    partial: records.filter((record) => record.status === "partial").length,
    missing: records.filter((record) => record.status === "missing").length,
    errors: toolErrors.length,
  };
}

function pad(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

function printHuman(records, summary, toolErrors) {
  const rows = records.map((record) => ({
    skillId: record.skillId,
    status: record.status,
    core: record.hasCoreProcedure ? "yes" : "no",
    scenarios: record.hasScenarioExtensions ? "yes" : "no",
    appendix: record.hasAppendix ? "yes" : "no",
    action: record.recommendedAction,
    notes: record.notes.join("; "),
  }));

  const columns = [
    ["skillId", "Skill"],
    ["status", "Status"],
    ["core", "Core"],
    ["scenarios", "Scenarios"],
    ["appendix", "Appendix"],
    ["action", "Action"],
    ["notes", "Notes"],
  ];
  const widths = columns.map(([key, label]) =>
    Math.max(label.length, ...rows.map((row) => String(row[key] ?? "").length), 3),
  );

  console.log("Skill Markdown Structure Check");
  console.log(`Summary: ${summary.compliant} compliant, ${summary.partial} partial, ${summary.missing} missing, ${summary.errors} errors`);
  console.log("");
  console.log(columns.map(([, label], index) => pad(label, widths[index])).join("  "));
  console.log(columns.map((_, index) => "-".repeat(widths[index])).join("  "));
  for (const row of rows) {
    console.log(columns.map(([key], index) => pad(row[key], widths[index])).join("  "));
  }

  if (toolErrors.length > 0) {
    console.log("");
    console.log("Errors:");
    for (const error of toolErrors) {
      console.log(`- ${error}`);
    }
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const cwd = process.cwd();
  const rootDir = path.resolve(cwd, options.root);
  const rootExists = await pathExists(rootDir);
  if (!rootExists) {
    const payload = {
      root: options.root,
      records: [],
      summary: summarize([], [`Skill root does not exist: ${options.root}`]),
      errors: [`Skill root does not exist: ${options.root}`],
    };
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      printHuman(payload.records, payload.summary, payload.errors);
    }
    process.exit(options.warnOnly ? 0 : 2);
  }

  const skillDirs = await discoverSkillDirs(rootDir);
  const records = [];
  const toolErrors = [];
  for (const skillDirPath of skillDirs) {
    const { record, errors } = await inspectSkillDir(cwd, skillDirPath);
    records.push(record);
    toolErrors.push(...errors);
  }

  const summary = summarize(records, toolErrors);
  const payload = {
    root: toPosixPath(path.relative(cwd, rootDir) || "."),
    records,
    summary,
    errors: toolErrors,
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printHuman(records, summary, toolErrors);
  }

  if (options.warnOnly) {
    process.exit(0);
  }
  if (toolErrors.length > 0) {
    process.exit(2);
  }
  process.exit(summary.partial > 0 || summary.missing > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(2);
});
