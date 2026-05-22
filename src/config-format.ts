export interface ValidationIssue {
  path: string;
  message: string;
}

export class SchemaValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[]) {
    super(message);
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

export class SimpleYamlParseError extends Error {
  readonly source: string;
  readonly line: number;

  constructor(message: string, source: string, line: number) {
    super(`${source}:${line}: ${message}`);
    this.name = "SimpleYamlParseError";
    this.source = source;
    this.line = line;
  }
}

function isQuoted(value: string): boolean {
  return (value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"));
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.length) {
    return "";
  }
  if (isQuoted(trimmed)) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function parseSimpleYamlDocument(input: string, source = "config"): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [{ indent: -1, value: root }];

  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    if (rawLine.includes("\t")) {
      throw new SimpleYamlParseError("tabs are not supported in this YAML subset", source, lineNumber);
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent % 2 !== 0) {
      throw new SimpleYamlParseError("indentation must use 2-space steps", source, lineNumber);
    }

    const content = rawLine.slice(indent);
    const match = content.match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (!match) {
      throw new SimpleYamlParseError(`unable to parse line: ${content}`, source, lineNumber);
    }

    const key = match[1];
    const rawValue = match[2] ?? "";

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    if (!parent) {
      throw new SimpleYamlParseError("invalid YAML nesting", source, lineNumber);
    }

    if (Object.hasOwn(parent.value, key)) {
      throw new SimpleYamlParseError(`duplicate key "${key}"`, source, lineNumber);
    }

    if (rawValue.length === 0) {
      const child: Record<string, unknown> = {};
      parent.value[key] = child;
      stack.push({ indent, value: child });
      continue;
    }

    parent.value[key] = parseScalar(rawValue);
  }

  return root;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function stringifyIssue(issue: ValidationIssue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

export function formatSchemaIssues(issues: ValidationIssue[], prefix: string): string {
  return `${prefix}\n- ${issues.map((issue) => stringifyIssue(issue)).join("\n- ")}`;
}

