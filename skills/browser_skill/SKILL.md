# browser_skill
Purpose: Browser automation using headless Chromium. Navigate pages, take screenshots, click elements, type text, and extract content.
Call name: "browser_skill"
Args: { action: "navigate"|"screenshot"|"click"|"type"|"evaluate"|"read_text"|"close", url?: "https://...", selector?: "css selector", text?: "text to type", script?: "JS expression" }
Actions:
- navigate: Open a URL, returns page title and text snippet. Args: { action: "navigate", url: "https://example.com" }
- screenshot: Capture the page or an element. Args: { action: "screenshot", selector?: "optional css" }. Saves to sandbox/screenshots/.
- click: Click an element. Args: { action: "click", selector: "#button" }
- type: Type into an input. Args: { action: "type", selector: "input[name=q]", text: "search query" }
- evaluate: Run JS on the page. Args: { action: "evaluate", script: "document.title" }
- read_text: Extract text content from the page or a selector. Args: { action: "read_text", selector?: "optional css" }
- close: Close the browser session. Args: { action: "close" }
Rules: Browser auto-closes after 5 minutes of inactivity. Screenshots saved under sandbox/screenshots/.
