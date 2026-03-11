# web_fetch_skill
Purpose: Fetch data from URLs via HTTP. Use for APIs, web pages, and any HTTP request. Prefer this over browser_skill for simple data retrieval. SSRF-protected with domain policy controls.

Call name: "web_fetch_skill"

## Args
- `url` (required): URL to fetch (must start with http:// or https://)
- `method`: HTTP method — GET, POST, PUT, DELETE, PATCH, HEAD (default: GET)
- `headers`: Optional HTTP headers object. Authorization/Cookie headers are stripped by default.
- `body`: Optional request body string
- `timeout`: Request timeout in ms (default: 10000, max: 30000)
- `maxBodySize`: Max response body chars to return (default: 4000, max: 50000)
- `retries`: Retry count for 429/5xx/timeouts with exponential backoff + jitter (default: 0, max: 3)
- `allowUnsafeHeaders`: Set true to allow Authorization/Cookie headers (default: false)
- `allowlist`: Optional array of allowed domains (e.g. ["api.example.com"])
- `denylist`: Optional array of blocked domains (e.g. ["evil.com"])

## Security
- **SSRF protection**: Blocks localhost, 127.0.0.1, private IP ranges (10.x, 172.16-31.x, 192.168.x), link-local, cloud metadata (169.254.169.254), and IPv6 loopback. Also resolves DNS to catch domains pointing to private IPs.
- **Header safety**: Authorization, Cookie, and Proxy-Authorization headers are stripped by default. Set `allowUnsafeHeaders: true` to override.
- **Domain policy**: Use `allowlist` to restrict to specific domains, or `denylist` to block specific domains.
- **Size limits**: 10MB max download, configurable response body truncation.

## Response Format
Structured JSON: `{ status: "ok"|"error", httpStatus?, url, contentType?, headers?, body?, truncated?, bytes?, elapsedMs, error? }`

## HTML Handling
HTML responses are automatically stripped to clean text (scripts, styles, nav, header, footer removed; entities decoded; whitespace collapsed).
