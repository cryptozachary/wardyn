# pdf_skill
Purpose: Extract text and metadata from PDF files inside the sandbox. Uses pdftotext (if available), Python pypdf, or built-in binary extraction as fallback.
Call name: "pdf_skill"
Actions:
- extract: Get text content from a PDF. Args: { action: "extract", filePath: "report.pdf", pages?: "1-5", maxChars?: 10000 }
- info: Get PDF metadata (page count, title, author, etc.). Args: { action: "info", filePath: "report.pdf" }
Rules: Files must be in sandbox/. Max 50MB PDF size. Max 50000 chars output. Path traversal blocked.
Returns: JSON with { status, action, path, chars?, truncated?, text?, pages?, elapsedMs }
Tip: Use filesystem_skill to download/save a PDF first, then use this skill to extract its contents.
