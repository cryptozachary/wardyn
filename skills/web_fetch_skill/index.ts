import axios from "axios";

export const parameters = {
  type: "object",
  properties: {
    url: { type: "string", description: "The URL to fetch (must start with http:// or https://)" },
    method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "HTTP method (default: GET)" },
    headers: { type: "object", description: "Optional HTTP headers" },
    body: { type: "string", description: "Optional request body" },
    timeout: { type: "number", description: "Request timeout in ms (default: 10000, max: 30000)" }
  },
  required: ["url"]
};

const MAX_BODY = 4000;
const DEFAULT_TIMEOUT = 10_000;

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function execute(args: any): Promise<string> {
  const { url, method = "GET", headers = {}, body, timeout = DEFAULT_TIMEOUT } = args;

  if (!url || typeof url !== "string") throw new Error("url is required");
  if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");

  const res = await axios({
    url,
    method: method.toUpperCase(),
    headers,
    data: body,
    timeout: Math.min(Number(timeout) || DEFAULT_TIMEOUT, 30_000),
    maxRedirects: 5,
    responseType: "text",
    validateStatus: () => true,
  });

  const contentType = res.headers["content-type"] || "unknown";
  let responseBody = typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);

  // Strip HTML to clean text if the response is HTML
  if (contentType.includes("text/html")) {
    responseBody = stripHtml(responseBody);
  }

  if (responseBody.length > MAX_BODY) {
    responseBody = responseBody.slice(0, MAX_BODY) + "\n...(truncated)";
  }

  return `HTTP ${res.status}\nContent-Type: ${contentType}\n\n${responseBody}`;
}
