import axios from "axios";

export const parameters = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query" },
    maxResults: { type: "number", description: "Max results to return (default: 5, max: 10)" },
  },
  required: ["query"],
};

/* ────────────────────── response ────────────────────── */

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchResponse {
  status: "ok" | "error";
  query: string;
  results: SearchResult[];
  elapsedMs: number;
  error?: string;
}

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { query, maxResults = 5 } = args;

  if (!query || typeof query !== "string") {
    return JSON.stringify({ status: "error", query: "", results: [], elapsedMs: 0, error: "query is required" });
  }

  const limit = Math.min(Math.max(maxResults, 1), 10);

  try {
    // Use DuckDuckGo HTML search — no API key required
    const res = await axios.get("https://html.duckduckgo.com/html/", {
      params: { q: query },
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      },
      timeout: 10000,
      responseType: "text",
    });

    const html: string = res.data;
    const results = parseResults(html, limit);

    const response: SearchResponse = {
      status: "ok",
      query,
      results,
      elapsedMs: Date.now() - start,
    };
    return JSON.stringify(response);
  } catch (err: any) {
    return JSON.stringify({
      status: "error",
      query,
      results: [],
      elapsedMs: Date.now() - start,
      error: err.message,
    });
  }
}

/* ────────────────────── HTML parser ────────────────────── */

function parseResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML results are in <a class="result__a"> tags
  const resultBlocks = html.split(/class="result__body"/gi);

  for (let i = 1; i < resultBlocks.length && results.length < limit; i++) {
    const block = resultBlocks[i];

    // Extract URL from result__a href
    const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/i)
      || block.match(/href="([^"]*)"[^>]*class="result__a"/i);

    // Extract title text
    const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</i);

    // Extract snippet from result__snippet
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)(?:<\/a|<\/td)/i);

    if (urlMatch && titleMatch) {
      let url = urlMatch[1];
      // DuckDuckGo wraps URLs in a redirect — extract the actual URL
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1]);
      }

      const snippet = snippetMatch
        ? snippetMatch[1].replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim()
        : "";

      const title = titleMatch[1].replace(/&[a-z]+;/gi, " ").trim();

      if (url.startsWith("http")) {
        results.push({ title, url, snippet });
      }
    }
  }

  // Fallback: try alternate parsing if result__body didn't work
  if (results.length === 0) {
    const linkPattern = /class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)/gi;
    let match;
    while ((match = linkPattern.exec(html)) !== null && results.length < limit) {
      let url = match[1];
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
      if (url.startsWith("http")) {
        results.push({ title: match[2].trim(), url, snippet: "" });
      }
    }
  }

  return results;
}
