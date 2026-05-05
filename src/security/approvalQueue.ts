/**
 * Skill Approval Queue — newly built or imported skills land in a pending
 * state and require manual approval before they're activated.
 *
 * Storage: SQLite `approvals` table (replaces config/approvals.json).
 * Pending skill files still live in `skills_pending/` on disk.
 */

import { existsSync, writeFileSync, mkdirSync, rmSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { BuilderResult } from "../builder/types.js";
import { writeSkill } from "../builder/skillWriter.js";
import type { ASTWarning } from "./astAnalyzer.js";
import { getDb } from "../db.js";
import { paths } from "../paths.js";

const PENDING_DIR = paths.skillsPending();

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

function ensurePendingDir(): void {
  if (!existsSync(PENDING_DIR)) mkdirSync(PENDING_DIR, { recursive: true });
}

function rowToApproval(r: any): ApprovalRequest {
  return {
    id: r.id,
    type: r.type,
    skillName: r.skill_name,
    language: r.language,
    description: r.description,
    code: r.code,
    wrapperCode: r.wrapper_code ?? undefined,
    skillMd: r.skill_md,
    parameters: JSON.parse(r.parameters),
    secrets: r.secrets ? JSON.parse(r.secrets) : undefined,
    sampleArgs: r.sample_args ? JSON.parse(r.sample_args) : undefined,
    author: r.author ?? undefined,
    requestedAt: r.requested_at,
    status: r.status,
    reviewedAt: r.reviewed_at ?? undefined,
    rejectReason: r.reject_reason ?? undefined,
    astWarnings: r.ast_warnings ? JSON.parse(r.ast_warnings) : undefined,
    validationOutput: r.validation_output ?? undefined,
  };
}

/* ───────── Public API ───────── */

export function submitForApproval(
  result: BuilderResult,
  type: "build" | "import",
  astWarnings?: ASTWarning[],
  author?: string
): ApprovalRequest {
  ensurePendingDir();

  const id = randomUUID();
  const now = Date.now();

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

  // Persist to SQLite
  const db = getDb();
  db.prepare(`
    INSERT INTO approvals
      (id, type, skill_name, language, description, code, wrapper_code, skill_md,
       parameters, secrets, sample_args, author, requested_at, status, ast_warnings, validation_output)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    id, type, result.name, result.language, result.description, result.code,
    result.wrapperCode ?? null, result.skillMd,
    JSON.stringify(result.parameters), result.secrets ? JSON.stringify(result.secrets) : null,
    result.sampleArgs ? JSON.stringify(result.sampleArgs) : null,
    author ?? null, now,
    astWarnings ? JSON.stringify(astWarnings) : null,
    result.validationOutput ?? null,
  );

  return rowToApproval(
    db.prepare("SELECT * FROM approvals WHERE id = ?").get(id)
  );
}

export function approveSkill(approvalId: string): { ok: boolean; error?: string } {
  const db = getDb();
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as any;
  if (!row) return { ok: false, error: "Approval request not found" };

  const request = rowToApproval(row);
  if (request.status !== "pending") {
    return { ok: false, error: `Skill is already ${request.status}` };
  }

  const pendingDir = path.join(PENDING_DIR, request.skillName);
  if (!existsSync(pendingDir)) {
    return { ok: false, error: "Pending skill files not found on disk" };
  }

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

  try { rmSync(pendingDir, { recursive: true, force: true }); } catch {}

  db.prepare("UPDATE approvals SET status = 'approved', reviewed_at = ? WHERE id = ?")
    .run(Date.now(), approvalId);

  return { ok: true };
}

export function rejectSkill(approvalId: string, reason?: string): { ok: boolean; error?: string } {
  const db = getDb();
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as any;
  if (!row) return { ok: false, error: "Approval request not found" };

  if (row.status !== "pending") {
    return { ok: false, error: `Skill is already ${row.status}` };
  }

  const pendingDir = path.join(PENDING_DIR, row.skill_name);
  try { rmSync(pendingDir, { recursive: true, force: true }); } catch {}

  db.prepare("UPDATE approvals SET status = 'rejected', reviewed_at = ?, reject_reason = ? WHERE id = ?")
    .run(Date.now(), reason ?? null, approvalId);

  return { ok: true };
}

export function listApprovals(status?: "pending" | "approved" | "rejected"): ApprovalRequest[] {
  const db = getDb();
  if (!status) {
    return (db.prepare("SELECT * FROM approvals ORDER BY requested_at DESC").all() as any[]).map(rowToApproval);
  }
  return (db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY requested_at DESC").all(status) as any[]).map(rowToApproval);
}

export function getApproval(id: string): ApprovalRequest | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as any;
  return row ? rowToApproval(row) : null;
}

export function isApprovalRequired(): boolean {
  return process.env.SKIP_APPROVAL !== "true";
}

export function pruneApprovals(): number {
  const db = getDb();
  const total = (db.prepare("SELECT COUNT(*) as cnt FROM approvals WHERE status != 'pending'").get() as any).cnt;
  if (total <= 100) return 0;

  const pruned = total - 100;
  db.prepare(`
    DELETE FROM approvals WHERE id IN (
      SELECT id FROM approvals WHERE status != 'pending'
      ORDER BY reviewed_at DESC
      LIMIT -1 OFFSET 100
    )
  `).run();
  return pruned;
}
