import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import type { BuilderResult } from "./types.js";

const SKILLS_DIR = path.join(process.cwd(), "skills");
const DIST_SKILLS_DIR = path.join(process.cwd(), "dist", "skills");

const PROTECTED_SKILLS = new Set([
  "exec_skill",
  "filesystem_skill",
  "browser_skill",
  "web_fetch_skill",
  "code_runner_skill",
  "database_skill",
]);

const LANGUAGE_FILES: Record<string, string> = {
  python: "main.py",
  go: "main.go",
  cpp: "main.cpp",
};

export function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 50);
}

export function skillExists(name: string): boolean {
  return existsSync(path.join(SKILLS_DIR, name));
}

export function isProtected(name: string): boolean {
  return PROTECTED_SKILLS.has(name);
}

export function writeSkill(result: BuilderResult): void {
  const skillDir = path.join(SKILLS_DIR, result.name);
  if (!existsSync(skillDir)) {
    mkdirSync(skillDir, { recursive: true });
  }

  // Write index.ts (either direct TS code or the wrapper)
  const indexContent = result.wrapperCode ?? result.code;
  writeFileSync(path.join(skillDir, "index.ts"), indexContent, "utf8");

  // Write SKILL.md
  writeFileSync(path.join(skillDir, "SKILL.md"), result.skillMd, "utf8");

  // For non-TS languages, write the main code file
  if (result.language !== "typescript") {
    const mainFile = LANGUAGE_FILES[result.language];
    if (mainFile) {
      writeFileSync(path.join(skillDir, mainFile), result.code, "utf8");
    }
  }

  // Compile to dist/ so the skill loader picks it up at runtime
  compileSkillToDist(result.name, skillDir);
}

/**
 * Compile a single skill's index.ts → dist/skills/<name>/index.js
 * and copy SKILL.md so the loader finds it.
 */
function compileSkillToDist(name: string, skillDir: string): void {
  const distDir = path.join(DIST_SKILLS_DIR, name);
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  try {
    const indexTs = path.join(skillDir, "index.ts");
    execSync(
      `npx tsc --outDir "${distDir}" --module nodenext --moduleResolution nodenext --target ES2022 --esModuleInterop --skipLibCheck --declaration false "${indexTs}"`,
      { cwd: process.cwd(), timeout: 30_000, stdio: "pipe" }
    );
  } catch {
    // Compilation may fail for non-TS skills during validation phase — that's OK,
    // the validator will catch it. Just ensure SKILL.md is copied.
  }

  // Copy SKILL.md to dist
  const srcMd = path.join(skillDir, "SKILL.md");
  if (existsSync(srcMd)) {
    writeFileSync(path.join(distDir, "SKILL.md"), readFileSync(srcMd, "utf8"), "utf8");
  }
}

export function deleteSkill(name: string): void {
  if (isProtected(name)) {
    throw new Error(`Cannot delete protected skill: ${name}`);
  }
  const skillDir = path.join(SKILLS_DIR, name);
  const distDir = path.join(process.cwd(), "dist", "skills", name);

  // Allow deletion if skill exists in either location
  if (!existsSync(skillDir) && !existsSync(distDir)) {
    throw new Error(`Skill "${name}" does not exist`);
  }

  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true, force: true });
  }

  // Also clean up compiled version in dist/ to prevent stale/orphaned skills
  if (existsSync(distDir)) {
    rmSync(distDir, { recursive: true, force: true });
  }
}
