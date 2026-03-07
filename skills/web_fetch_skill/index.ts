import axios from "axios";

const MAX_BODY = 4000;
const DEFAULT_TIMEOUT = 10_000;

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
  if (responseBody.length > MAX_BODY) {
    responseBody = responseBody.slice(0, MAX_BODY) + "\n...(truncated)";
  }

  return `HTTP ${res.status}\nContent-Type: ${contentType}\n\n${responseBody}`;
}
