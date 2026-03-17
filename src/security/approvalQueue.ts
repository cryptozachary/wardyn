/**
 * Skill Approval Queue — newly built or imported skills land in a pending
 * state and require manual approval before they're activated (loaded into
 * the runtime skill set). Approved skills are moved from `skills_pending/`
 * to `skills/` and compiled to `dist/skills/`.
 *
 * Storage: `config/approvals.json` — a flat list of ApprovalRequest entries.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { BuilderResult } from "../builder/types.js";
import { writeSkill, deleteSkill } from "../builder/skillWriter.js";
import type { ASTWarning } from "./astAnalyzer.js";

const CONFIG_DIR = path.join(process.cwd(), "config");
const APPROVALS_FILE = path.join(CONFIG_DIR, "approvals.json");
const PENDING_DIR = path.join(process.cwd(), "skills_pending");

/* ───────── Types ───────── */

export interface ApprovalRequest {
  id: string;
  type: "build" | "import";
  skillName: string;
  language: string;
  description: string;
  code: string;
  wrapperCode?: string;
  skillMd: string;
  parameters: Record<string, unknown>;
  secrets?: Record<string, { description: string; required?: boolean }>;
  sampleArgs?: Record<string, unknown>;
  author?: string;
  requestedAt: number;
  status: "pending" | "approved" | "rejected";
  reviewedAt?: number;
  rejectReason?: string;
  astWarnings?: ASTWarning[];
  validationOutput?: string;
}

/* ───────── Helpers ───────── */

function ensureDirs(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(PENDING_DIR)) mkdirSync(PENDING_DIR, { recursive: true });
}

function loadQueue(): ApprovalRequest[] {
  if (!existsSync(APPROVALS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(APPROVALS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveQueue(queue: ApprovalRequest[]): void {
  ensureDirs();
  writeFileSync(APPROVALS_FILE, JSON.stringify(queue, null, 2), "utf8");
}

/* ───────── Public API ───────── */

/**
 * Submit a newly built skill for approval.
 * Writes skill files to `skills_pending/{name}/` instead of `skills/`.
 */
export function submitForApproval(
  result: BuilderResult,
  type: "build" | "import",
  astWarnings?: ASTWarning[],
  author?: string
): ApprovalRequest {
  ensureDirs();

  const request: ApprovalRequest = {
    id: randomUUID(),
    type,
    skillName: result.name,
    language: result.language,
    description: result.description,
    code: result.code,
    wrapperCode: result.wrapperCode,
    skillMd: result.skillMd,
    parameters: result.parameters,
    secrets: result.secrets,
    sampleArgs: result.sampleArgs,
    author,
    requestedAt: Date.now(),
    status: "pending",
    astWarnings,
    validationOutput: result.validationOutput,
  };

  // Write skill files to pending directory for review
  const pendingSkillDir = path.join(PENDING_DIR, result.name);
  if (!existsSync(pendingSkillDir)) mkdirSync(pendingSkillDir, { recursive: true });

  const LANGUAGE_FILES: Record<string, string> = { python: "main.py", go: "main.go", cpp: "main.cpp" };

  const indexContent = result.wrapperCode ?? result.code;
  writeFileSync(path.join(pendingSkillDir, "index.ts"), indexContent, "utf8");
  writeFileSync(path.join(pendingSkillDir, "SKILL.md"), result.skillMd, "utf8");

  if (result.language !== "typescript") {
    const mainFile = LANGUAGE_FILES[result.language];
    if (mainFile) {
      writeFileSync(path.join(pendingSkillDir, mainFile), result.code, "utf8");
    }
  }

  // Persist to queue
  const queue = loadQueue();
  queue.push(request);
  saveQueue(queue);

  return request;
}

/**
 * Approve a pending skill — moves from pending to active.
 */
export function approveSkill(approvalId: string): { ok: boolean; error?: string } {
  const queue = loadQueue();
  const idx = queue.findIndex(r => r.id === approvalId);
  if (idx < 0) return { ok: false, error: "Approval request not found" };

  const request = queue[idx];
  if (request.status !== "pending") {
    return { ok: false, error: `Skill is already ${request.status}` };
  }

  // Move files from pending to active
  const pendingDir = path.join(PENDING_DIR, request.skillName);
  if (!existsSync(pendingDir)) {
    return { ok: false, error: "Pending skill files not found on disk" };
  }

  // Use writeSkill to properly install (includes compilation to dist/)
  const builderResult: BuilderResult = {
    name: request.skillName,
    language: request.language,
    description: request.description,
    parameters: request.parameters,
    secrets: request.secrets,
    code: request.code,
    wrapperCode: request.wrapperCode,
    skillMd: request.skillMd,
    validationOutput: request.validationOutput ?? "",
    success: true,
    attempts: 1,
    sampleArgs: request.sampleArgs,
  };

  try {
    writeSkill(builderResult);
  } catch (err: any) {
    return { ok: false, error: `Failed to install skill: ${err.message}` };
  }

  // Clean up pending directory
  try { rmSync(pendingDir, { recursive: true, force: true }); } catch {}

  // Update status
  request.status = "approved";
  request.reviewedAt = Date.now();
  queue[idx] = request;
  saveQueue(queue);

  return { ok: true };
}

/**
 * Reject a pending skill — removes pending files.
 */
export function rejectSkill(approvalId: string, reason?: string): { ok: boolean; error?: string } {
  const queue = loadQueue();
  const idx = queue.findIndex(r => r.id === approvalId);
  if (idx < 0) return { ok: false, error: "Approval request not found" };

  const request = queue[idx];
  if (request.status !== "pending") {
    return { ok: false, error: `Skill is already ${request.status}` };
  }

  // Remove pending files
  const pendingDir = path.join(PENDING_DIR, request.skillName);
  try { rmSync(pendingDir, { recursive: true, force: true }); } catch {}

  // Update status
  request.status = "rejected";
  request.reviewedAt = Date.now();
  request.rejectReason = reason;
  queue[idx] = request;
  saveQueue(queue);

  return { ok: true };
}

/**
 * Get all approval requests, optionally filtered by status.
 */
export function listApprovals(status?: "pending" | "approved" | "rejected"): ApprovalRequest[] {
  const queue = loadQueue();
  if (!status) return queue;
  return queue.filter(r => r.status === status);
}

/**
 * Get a single approval request by ID.
 */
export function getApproval(id: string): ApprovalRequest | null {
  const queue = loadQueue();
  return queue.find(r => r.id === id) ?? null;
}

/**
 * Check if approval queue is enabled.
 * Can be disabled via SKIP_APPROVAL=true env var for development.
 */
export function isApprovalRequired(): boolean {
  return process.env.SKIP_APPROVAL !== "true";
}

/**
 * Clean up old approved/rejected entries (keep last 100).
 */
export function pruneApprovals(): number {
  const queue = loadQueue();
  const pending = queue.filter(r => r.status === "pending");
  const resolved = queue.filter(r => r.status !== "pending");

  if (resolved.length <= 100) return 0;

  // Keep newest 100 resolved entries
  const sorted = resolved.sort((a, b) => (b.reviewedAt ?? 0) - (a.reviewedAt ?? 0));
  const pruned = resolved.length - 100;
  const kept = [...pending, ...sorted.slice(0, 100)];
  saveQueue(kept);
  return pruned;
}
