# filesystem_skill
Purpose: Safe file access inside /sandbox only.
Call name: "filesystem_skill"
Args: { action: "read"|"write", filePath: "relative/path.txt", data?: "string" }
Rules: Only operate under /sandbox. Reject paths with ".." or absolute roots.
