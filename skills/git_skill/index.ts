import { execFile } from "child_process";
import path from "path";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["status", "log", "diff", "branch", "checkout", "commit", "add", "stash", "blame", "show"],
      description: "Git action to perform",
    },
    repoPath: {
      type: "string",
      description: "Relative path to repo inside sandbox (default: sandbox root). Must be within sandbox/.",
    },
    // Action-specific args
    message: { type: "string", description: "Commit message (required for commit)" },
    files: {
      type: "array",
      items: { type: "string" },
      description: "Files to add/stage (for add action). Use ['.'] for all.",
    },
    branch: { type: "string", description: "Branch name (for checkout/branch)" },
    createBranch: { type: "boolean", description: "Create new branch on checkout (default: false)" },
    filePath: { type: "string", description: "File path for blame/diff (relative to repo)" },
    count: { type: "number", description: "Number of log entries (default: 10, max: 50)" },
    stashAction: { type: "string", enum: ["push", "pop", "list", "drop"], description: "Stash sub-action (default: push)" },
    ref: { type: "string", description: "Commit ref for show (default: HEAD)" },
  },
  required: ["action"],
};

/* ────────────────────── constants ────────────────────── */

const SANDBOX_DIR = path.join(process.cwd(), "sandbox");
const TIMEOUT = 15000;
const MAX_OUTPUT = 20000; // chars

// Blocked git commands that could be destructive or escape sandbox
const BLOCKED_ACTIONS = new Set(["push", "pull", "fetch", "remote", "clone", "submodule", "rebase", "reset"]);

/* ────────────────────── path safety ────────────────────── */

function safeRepoPath(relPath?: string): string {
  if (!relPath) return SANDBOX_DIR;
  if (path.isAbsolute(relPath)) throw new Error("Absolute paths not allowed");
  const resolved = path.resolve(SANDBOX_DIR, relPath);
  const normalSandbox = path.resolve(SANDBOX_DIR) + path.sep;
  if (!resolved.startsWith(normalSandbox) && resolved !== path.resolve(SANDBOX_DIR)) {
    throw new Error("Path escapes sandbox boundary");
  }
  return resolved;
}

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { action, repoPath } = args;

  if (BLOCKED_ACTIONS.has(action)) {
    return JSON.stringify({
      status: "error",
      action,
      error: `Action "${action}" is blocked for security — no remote operations allowed from sandbox.`,
      elapsedMs: 0,
    });
  }

  try {
    const cwd = safeRepoPath(repoPath);
    let gitArgs: string[];

    switch (action) {
      case "status":
        gitArgs = ["status", "--porcelain", "-b"];
        break;

      case "log": {
        const count = Math.min(Math.max(1, Number(args.count) || 10), 50);
        gitArgs = ["log", `--max-count=${count}`, "--pretty=format:%H|%an|%ai|%s", "--no-color"];
        break;
      }

      case "diff": {
        gitArgs = ["diff", "--stat"];
        if (args.filePath) gitArgs.push("--", args.filePath);
        break;
      }

      case "branch": {
        if (args.branch) {
          // Create branch
          gitArgs = ["branch", args.branch];
        } else {
          // List branches
          gitArgs = ["branch", "-a", "--no-color"];
        }
        break;
      }

      case "checkout": {
        if (!args.branch) throw new Error("branch is required for checkout");
        gitArgs = args.createBranch ? ["checkout", "-b", args.branch] : ["checkout", args.branch];
        break;
      }

      case "add": {
        const files = args.files;
        if (!files || !Array.isArray(files) || files.length === 0) {
          throw new Error("files array is required for add (use ['.'] for all)");
        }
        gitArgs = ["add", ...files];
        break;
      }

      case "commit": {
        if (!args.message || typeof args.message !== "string") {
          throw new Error("message is required for commit");
        }
        gitArgs = ["commit", "-m", args.message];
        break;
      }

      case "stash": {
        const sub = args.stashAction || "push";
        switch (sub) {
          case "push":
            gitArgs = ["stash", "push"];
            if (args.message) gitArgs.push("-m", args.message);
            break;
          case "pop":
            gitArgs = ["stash", "pop"];
            break;
          case "list":
            gitArgs = ["stash", "list"];
            break;
          case "drop":
            gitArgs = ["stash", "drop"];
            break;
          default:
            throw new Error(`Unknown stash action: ${sub}`);
        }
        break;
      }

      case "blame": {
        if (!args.filePath) throw new Error("filePath is required for blame");
        gitArgs = ["blame", "--porcelain", args.filePath];
        break;
      }

      case "show": {
        const ref = args.ref || "HEAD";
        gitArgs = ["show", "--stat", "--no-color", ref];
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    const output = await runGit(gitArgs, cwd);
    const truncated = output.length > MAX_OUTPUT;

    return JSON.stringify({
      status: "ok",
      action,
      output: truncated ? output.slice(0, MAX_OUTPUT) : output,
      truncated,
      elapsedMs: Date.now() - start,
    });
  } catch (err: any) {
    return JSON.stringify({ status: "error", action, error: err.message, elapsedMs: Date.now() - start });
  }
}

/* ────────────────────── helpers ────────────────────── */

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { timeout: TIMEOUT, maxBuffer: 5 * 1024 * 1024, cwd }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        return reject(new Error(msg));
      }
      resolve((stdout + (stderr ? `\n${stderr}` : "")).trim());
    });
  });
}
