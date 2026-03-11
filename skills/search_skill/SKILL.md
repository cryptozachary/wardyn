# search_skill
Purpose: Search the web using DuckDuckGo. No API key required. Use this when you need to find information, look up current events, or research topics.
Call name: "search_skill"
Args: { query: "search terms", maxResults?: 5 }
Returns: JSON with `{ status, query, results: [{ title, url, snippet }], elapsedMs }`
Rules: Max 10 results per query. Use web_fetch_skill to read full page content after finding URLs.
