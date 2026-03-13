# git_skill
Purpose: Perform local git operations on repositories inside the sandbox. No remote operations (push/pull/fetch) allowed.
Call name: "git_skill"
Actions:
- status: Show working tree status. Args: { action: "status", repoPath?: "myrepo" }
- log: Show commit history. Args: { action: "log", count?: 10, repoPath?: "myrepo" }
- diff: Show file changes. Args: { action: "diff", filePath?: "src/main.ts", repoPath?: "myrepo" }
- branch: List or create branches. Args: { action: "branch", branch?: "feature-x", repoPath?: "myrepo" }
- checkout: Switch branches. Args: { action: "checkout", branch: "main", createBranch?: true }
- add: Stage files. Args: { action: "add", files: ["file1.ts", "file2.ts"] } — use ["."] for all
- commit: Create a commit. Args: { action: "commit", message: "fix: resolve bug" }
- stash: Manage stash. Args: { action: "stash", stashAction: "push"|"pop"|"list"|"drop", message?: "wip" }
- blame: Show line-by-line authorship. Args: { action: "blame", filePath: "src/main.ts" }
- show: Show commit details. Args: { action: "show", ref?: "HEAD" }
Security: All operations are sandboxed. Remote operations (push, pull, fetch, clone, rebase, reset) are blocked. Paths must stay within sandbox/.
Returns: JSON with { status, action, output, truncated?, elapsedMs }
