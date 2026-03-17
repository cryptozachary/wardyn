import path from "path";
import { realpathSync } from "fs";
import express from "express";

/**
 * Middleware that prevents path traversal on static file routes.
 * Resolves the real path (following symlinks) and ensures it stays
 * within the allowed root directory.
 */
export function safeStatic(root: string): express.RequestHandler[] {
  const resolvedRoot = realpathSync(path.resolve(root));

  const guard: express.RequestHandler = (req, res, next) => {
    // Decode and normalize the URL path
    const decoded = decodeURIComponent(req.path);

    // Block null bytes
    if (decoded.includes("\0")) {
      return res.status(400).json({ ok: false, error: "invalid path" });
    }

    // Block obvious traversal patterns before hitting the filesystem
    const normalized = path.normalize(decoded);
    if (normalized.includes("..")) {
      return res.status(403).json({ ok: false, error: "path traversal blocked" });
    }

    // Resolve the full filesystem path
    const requested = path.resolve(resolvedRoot, "." + normalized);

    // Ensure the resolved path is within the allowed root
    if (!requested.startsWith(resolvedRoot)) {
      return res.status(403).json({ ok: false, error: "path traversal blocked" });
    }

    next();
  };

  return [guard, express.static(resolvedRoot)];
}

/**
 * Validate and sanitize a file path parameter.
 * Returns the safe path or throws if traversal is detected.
 */
export function safePath(root: string, userPath: string): string {
  if (userPath.includes("\0")) {
    throw new Error("Null byte in path");
  }

  const normalized = path.normalize(userPath);
  if (normalized.includes("..")) {
    throw new Error("Path traversal detected");
  }

  const resolved = path.resolve(root, normalized);
  const resolvedRoot = path.resolve(root);

  if (!resolved.startsWith(resolvedRoot)) {
    throw new Error("Path traversal detected");
  }

  return resolved;
}
