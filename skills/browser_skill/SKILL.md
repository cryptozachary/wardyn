# browser_skill
Purpose: Secure browser automation using headless Chromium. Navigate pages, take screenshots, interact with elements, manage tabs, extract structured data, and manage cookies. SSRF-protected, session-isolated per user/channel.

Call name: "browser_skill"

## Actions

### Navigation & Page
- **navigate**: Open a URL. Args: `{ action: "navigate", url: "https://example.com", waitUntil?: "domcontentloaded"|"networkidle"|"load"|"commit" }`. Returns title + text snippet.
- **back**: Go back in history. Args: `{ action: "back" }`
- **forward**: Go forward in history. Args: `{ action: "forward" }`
- **scroll**: Scroll the page. Args: `{ action: "scroll", direction?: "up"|"down"|"left"|"right", amount?: 500 }`
- **wait**: Wait for a selector or fixed time. Args: `{ action: "wait", selector?: "css", amount?: 1000 }`

### Interaction
- **click**: Click an element. Args: `{ action: "click", selector: "#button" }`
- **type**: Type into an input. Args: `{ action: "type", selector: "input[name=q]", text: "query" }`
- **hover**: Hover over an element. Args: `{ action: "hover", selector: ".menu-item" }`
- **select**: Select a dropdown option. Args: `{ action: "select", selector: "select#country", value: "US" }`

### Data Extraction
- **read_text**: Extract text from page or element. Args: `{ action: "read_text", selector?: "css" }`. Returns up to 3000 chars.
- **extract**: Schema-based extraction. Args: `{ action: "extract", fields: { price: ".price", title: "h1", rating: ".stars" } }`. Returns `{ data: { price: "...", title: "...", rating: "..." } }`.
- **screenshot**: Capture page or element. Args: `{ action: "screenshot", selector?: "css", fullPage?: true }`. Saves to `/output/` and returns path.

### Tabs
- **open_tab**: Open a new tab. Args: `{ action: "open_tab", url?: "https://..." }`
- **switch_tab**: Switch active tab. Args: `{ action: "switch_tab", tabIndex: 0 }`
- **close_tab**: Close a tab. Args: `{ action: "close_tab", tabIndex?: 0 }`

### Other
- **cookies**: Manage cookies. Args: `{ action: "cookies", cookieAction: "get"|"set"|"clear", cookie?: { name, value, domain?, path? } }`
- **evaluate**: Run JS on the page (**requires `unsafe: true`**). Args: `{ action: "evaluate", script: "document.title", unsafe: true }`
- **close**: End browser session. Args: `{ action: "close" }`

## Global Options
- `waitFor`: CSS selector to wait for before performing the action (explicit pre-wait)
- `timeout`: Action timeout in ms (default: 10000)
- `retries`: Retry count for transient failures (0-3, default: 0)
- `blockImages`: Block image loading (default: true). Set false for screenshot quality.
- `blockFonts`: Block font loading (default: true). Set false for visual fidelity.

## Security
- SSRF protection: localhost, 127.0.0.1, private IP ranges (10.x, 172.16-31.x, 192.168.x), link-local, and cloud metadata endpoints are blocked.
- evaluate is disabled by default — requires `unsafe: true` flag.
- Sessions are isolated per user/channel with 5-minute idle TTL.

## Response Format
All actions return structured JSON: `{ status: "ok"|"error", action, url?, title?, text?, path?, data?, elapsedMs, error? }`
