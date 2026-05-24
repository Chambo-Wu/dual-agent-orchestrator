import type { SearchConfig, SearchRequest, SearchResult } from "../types.js";

export interface SearchProvider {
  buildRequest(query: string, count: number): SearchRequest;
  parseResults(body: string, count: number): SearchResult[];
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Bing HTML Provider
// ---------------------------------------------------------------------------

class BingHtmlProvider implements SearchProvider {
  private urlTemplate: string;
  constructor(providerConfig: Record<string, unknown>) {
    this.urlTemplate = typeof providerConfig.url_template === "string"
      ? providerConfig.url_template
      : "https://www.bing.com/search?q={query}";
  }
  buildRequest(query: string): SearchRequest {
    return { url: this.urlTemplate.replace("{query}", encodeURIComponent(query)) };
  }
  parseResults(body: string, count: number): SearchResult[] {
    return parseBingHtml(body, count);
  }
}

function cleanBingTitle(title: string, url: string): string {
  // Remove URL prefix that Bing sometimes adds to titles
  // Pattern: "domain.com https://www.example.com › path › ..."
  const urlMatch = url.match(/^https?:\/\/([^/]+)/);
  if (urlMatch) {
    const domain = urlMatch[1];
    // Remove domain prefix and URL from title
    const cleaned = title
      .replace(new RegExp(`^${domain.replace(/\./g, "\\.")}\\s+`, "i"), "")
      .replace(/https?:\/\/[^\s›]+/g, "")
      .replace(/›/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned || title;
  }
  return title;
}

function parseBingHtml(html: string, count: number): SearchResult[] {
  const results: SearchResult[] = [];
  const bingPatterns = [
    new RegExp('<li[^>]+class="b_algo"[^>]*>[\\s\\S]*?<a[^>]+href="(https?://[^"]+)"[^>]*>([\\s\\S]*?)</a>[\\s\\S]*?(?:<p[^>]*>([\\s\\S]*?)</p>|<span[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\\s\\S]*?)</span>)', "gi"),
    new RegExp('<li[^>]+class="b_algo"[^>]*>[\\s\\S]*?<a[^>]+href="(https?://[^"]+)"[^>]*>([\\s\\S]*?)</a>[\\s\\S]*?<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\\s\\S]*?(?:<p[^>]*>([\\s\\S]*?)</p>|<span[^>]*>([\\s\\S]*?)</span>)', "gi"),
    new RegExp('<li[^>]+class="b_algo"[^>]*>[\\s\\S]*?<a[^>]+href="(https?://[^"]+)"[^>]*>([\\s\\S]*?)</a>[\\s\\S]*?<cite[^>]*>([\\s\\S]*?)</cite>', "gi"),
  ];
  for (const re of bingPatterns) {
    for (const m of html.matchAll(re)) {
      if (results.length >= count) break;
      const url = m[1] || "";
      const rawTitle = stripHtmlTags(m[2] || "");
      const snippet = stripHtmlTags(m[3] || m[4] || "");
      const title = cleanBingTitle(rawTitle, url);
      if (url && title && url.startsWith("http")) results.push({ title, url, snippet });
    }
    if (results.length > 0) return results;
  }
  return results;
}

// ---------------------------------------------------------------------------
// SearXNG Provider (JSON API)
// ---------------------------------------------------------------------------

class SearxngProvider implements SearchProvider {
  private baseUrl: string;
  constructor(providerConfig: Record<string, unknown>, _apiKey: string) {
    this.baseUrl = typeof providerConfig.base_url === "string" ? providerConfig.base_url : "http://localhost:8888";
  }
  buildRequest(query: string): SearchRequest {
    return { url: `${this.baseUrl}/search?q=${encodeURIComponent(query)}&format=json` };
  }
  parseResults(body: string, count: number): SearchResult[] {
    try {
      const data = JSON.parse(body);
      const items = data.web?.results || data.results || [];
      return items.slice(0, count).map((r: Record<string, unknown>) => ({
        title: String(r.title || ""),
        url: String(r.url || ""),
        snippet: String(r.description || r.snippet || ""),
      }));
    } catch { return []; }
  }
}

// ---------------------------------------------------------------------------
// SerpAPI Provider (JSON API)
// ---------------------------------------------------------------------------

class SerpApiProvider implements SearchProvider {
  private engine: string;
  private apiKey: string;
  constructor(providerConfig: Record<string, unknown>, apiKey: string) {
    this.engine = typeof providerConfig.engine === "string" ? providerConfig.engine : "google";
    this.apiKey = apiKey;
  }
  buildRequest(query: string): SearchRequest {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&engine=${this.engine}&api_key=${this.apiKey}`;
    return { url };
  }
  parseResults(body: string, count: number): SearchResult[] {
    try {
      const data = JSON.parse(body);
      const items = data.organic_results || [];
      return items.slice(0, count).map((r: Record<string, unknown>) => ({
        title: String(r.title || ""),
        url: String(r.link || ""),
        snippet: String(r.snippet || ""),
      }));
    } catch { return []; }
  }
}

// ---------------------------------------------------------------------------
// Bing Web Search API Provider (JSON API)
// ---------------------------------------------------------------------------

class BingApiProvider implements SearchProvider {
  private endpoint: string;
  private market: string;
  private apiKey: string;
  constructor(providerConfig: Record<string, unknown>, apiKey: string) {
    this.endpoint = typeof providerConfig.endpoint === "string" ? providerConfig.endpoint : "https://api.bing.microsoft.com/v7.0/search";
    this.market = typeof providerConfig.market === "string" ? providerConfig.market : "en-US";
    this.apiKey = apiKey;
  }
  buildRequest(query: string): SearchRequest {
    return {
      url: `${this.endpoint}?q=${encodeURIComponent(query)}&mkt=${this.market}`,
      headers: { "Ocp-Apim-Subscription-Key": this.apiKey },
    };
  }
  parseResults(body: string, count: number): SearchResult[] {
    try {
      const data = JSON.parse(body);
      const items = data.webPages?.value || [];
      return items.slice(0, count).map((r: Record<string, unknown>) => ({
        title: String(r.name || ""),
        url: String(r.url || ""),
        snippet: String(r.snippet || ""),
      }));
    } catch { return []; }
  }
}

// ---------------------------------------------------------------------------
// Google Custom Search Engine Provider (JSON API)
// ---------------------------------------------------------------------------

class GoogleCseProvider implements SearchProvider {
  private cx: string;
  private endpoint: string;
  private apiKey: string;
  constructor(providerConfig: Record<string, unknown>, apiKey: string) {
    this.cx = typeof providerConfig.cx === "string" ? providerConfig.cx : "";
    this.endpoint = typeof providerConfig.endpoint === "string" ? providerConfig.endpoint : "https://www.googleapis.com/customsearch/v1";
    this.apiKey = apiKey;
  }
  buildRequest(query: string): SearchRequest {
    return { url: `${this.endpoint}?q=${encodeURIComponent(query)}&cx=${this.cx}&key=${this.apiKey}` };
  }
  parseResults(body: string, count: number): SearchResult[] {
    try {
      const data = JSON.parse(body);
      const items = data.items || [];
      return items.slice(0, count).map((r: Record<string, unknown>) => ({
        title: String(r.title || ""),
        url: String(r.link || ""),
        snippet: String(r.snippet || ""),
      }));
    } catch { return []; }
  }
}

// ---------------------------------------------------------------------------
// URL Template Provider (legacy env var compatible)
// ---------------------------------------------------------------------------

class UrlTemplateProvider implements SearchProvider {
  private urlTemplate: string;
  constructor(providerConfig: Record<string, unknown>) {
    this.urlTemplate = typeof providerConfig.url_template === "string"
      ? providerConfig.url_template
      : "https://www.bing.com/search?q={query}";
  }
  buildRequest(query: string): SearchRequest {
    return { url: this.urlTemplate.replace("{query}", encodeURIComponent(query)) };
  }
  parseResults(body: string, count: number): SearchResult[] {
    return parseBingHtml(body, count);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSearchProvider(config: SearchConfig): SearchProvider {
  const providerConfig = config.providers[config.provider] || {};
  switch (config.provider) {
    case "bing_html": return new BingHtmlProvider(providerConfig);
    case "searxng": return new SearxngProvider(providerConfig, config.apiKey);
    case "serpapi": return new SerpApiProvider(providerConfig, config.apiKey);
    case "bing_api": return new BingApiProvider(providerConfig, config.apiKey);
    case "google_cse": return new GoogleCseProvider(providerConfig, config.apiKey);
    case "url_template": return new UrlTemplateProvider(providerConfig);
    case "mcp": throw new Error("MCP provider should be handled by mcp-client, not createSearchProvider");
    default: return new BingHtmlProvider(providerConfig);
  }
}
