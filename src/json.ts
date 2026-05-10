export function parseJsonObject<T>(text: string): T {
  const trimmed = text.trim();
  return JSON.parse(trimmed) as T;
}

export function tryParseJsonObject<T>(text: string): T | null {
  try {
    return parseJsonObject<T>(text);
  } catch {
    return null;
  }
}

export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseModelJson<T>(text: string): T {
  const direct = tryParseJsonObject<T>(text);
  if (direct) return direct;

  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch) {
    const fromCodeBlock = tryParseJsonObject<T>(codeBlockMatch[1]);
    if (fromCodeBlock) return fromCodeBlock;
  }

  const embedded = extractFirstJsonObject(text);
  if (embedded) return parseJsonObject<T>(embedded);

  return parseJsonObject<T>(text);
}
