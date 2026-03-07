# web_fetch_skill
Purpose: Fetch data from URLs via HTTP. Use for APIs, web pages, and any HTTP request. Prefer this over browser_skill for simple data retrieval.
Call name: "web_fetch_skill"
Args: { url: "https://...", method?: "GET"|"POST"|"PUT"|"DELETE", headers?: {}, body?: "string or JSON", timeout?: 10000 }
Returns: HTTP status, response headers (content-type, etc.), and response body (truncated to 4000 chars).
Rules: Only http/https URLs allowed. Default method is GET. Default timeout is 10 seconds.
