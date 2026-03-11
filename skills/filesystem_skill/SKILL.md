# filesystem_skill
Purpose: Safe file operations inside /sandbox only. All paths are validated with canonical resolve + realpath to block traversal and symlink escapes.

Call name: "filesystem_skill"

## Actions

- **read**: Read a file. Args: `{ action: "read", filePath: "notes/todo.txt", offset?: 1, limit?: 100, encoding?: "utf8"|"base64" }`. Max 2MB. Supports line-range reads.
- **write**: Write a file (atomic: temp + rename). Args: `{ action: "write", filePath: "notes/todo.txt", data: "content", encoding?: "utf8"|"base64" }`. Max 5MB. Creates parent dirs.
- **append**: Append to a file. Args: `{ action: "append", filePath: "log.txt", data: "new line\n" }`. Max 5MB per call.
- **list**: List directory contents. Args: `{ action: "list", filePath: "notes" }`. Returns `[{ name, type: "file"|"dir" }]`.
- **exists**: Check if path exists. Args: `{ action: "exists", filePath: "notes/todo.txt" }`. Returns `{ exists, type?, bytes? }`.
- **stat**: Get file metadata. Args: `{ action: "stat", filePath: "notes/todo.txt" }`. Returns size, created, modified, permissions.
- **mkdir**: Create directory (recursive). Args: `{ action: "mkdir", filePath: "notes/archive" }`.
- **delete**: Delete file or directory. Args: `{ action: "delete", filePath: "notes/old.txt" }`.
- **rename**: Move/rename. Args: `{ action: "rename", filePath: "old.txt", destPath: "new.txt" }`.
- **copy**: Copy a file. Args: `{ action: "copy", filePath: "notes/todo.txt", destPath: "backup/todo.txt" }`. Max 5MB.

## Security
- All paths resolved canonically with `path.resolve` + `fs.realpath` — blocks `../` traversal and symlink escapes.
- Absolute paths rejected.
- Writes are atomic (temp file + rename) to prevent corruption.
- Size limits: 2MB read, 5MB write/copy.

## Response Format
All actions return structured JSON: `{ status: "ok"|"error", action, path?, bytes?, lines?, mtime?, data?, error? }`
