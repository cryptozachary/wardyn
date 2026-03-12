# clipboard_skill
Purpose: Read from and write to the system clipboard. Works on Windows, macOS, and Linux.
Call name: "clipboard_skill"
Actions:
- read: Get current clipboard contents. Args: { action: "read" }
- write: Set clipboard contents. Args: { action: "write", text: "content to copy" }
Rules: Max 100KB text. Uses native commands (PowerShell/pbcopy/xclip).
Returns: JSON with { status, action, text?, chars, truncated?, elapsedMs }
