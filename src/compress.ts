const DEFAULT_MAX_CHARS = 800;
const HEAD_RATIO = 0.7;

export function compressToolOutput(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (!text || text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * HEAD_RATIO);
  const tailLen = maxChars - headLen - 30; // reserve for marker
  if (tailLen < 20) return text.slice(0, maxChars);
  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);
  const omitted = text.length - headLen - tailLen;
  return `${head}\n[...${omitted} chars omitted...]\n${tail}`;
}

export function compressJsonOutput(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (!text || text.length <= maxChars) return text;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed) && parsed.length > 5) {
      const summary = `[Array with ${parsed.length} items] First 3:\n${JSON.stringify(parsed.slice(0, 3), null, 2)}`;
      return compressToolOutput(summary, maxChars);
    }
    if (typeof parsed === "object" && parsed !== null) {
      const keys = Object.keys(parsed as Record<string, unknown>);
      if (keys.length > 10) {
        const subset: Record<string, unknown> = {};
        for (const k of keys.slice(0, 5)) subset[k] = (parsed as Record<string, unknown>)[k];
        const summary = `{${keys.length} keys} First 5:\n${JSON.stringify(subset, null, 2)}`;
        return compressToolOutput(summary, maxChars);
      }
    }
  } catch {
    // not JSON, use plain compression
  }
  return compressToolOutput(text, maxChars);
}
