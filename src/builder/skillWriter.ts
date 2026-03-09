import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import path from "path";
import type { BuilderResult } from "./types.js";

const SKILLS_DIR = path.join(process.cwd(), "skills");

const PROTECTED_SKILLS = new Set([
  "exec_skill",
  "filesystem_skill",
  "browser_skill",
  "web_fetch_skill",
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
}

export function deleteSkill(name: string): void {
  if (isProtected(name)) {
    throw new Error(`Cannot delete protected skill: ${name}`);
  }
  const skillDir = path.join(SKILLS_DIR, name);
  if (!existsSync(skillDir)) {
    throw new Error(`Skill "${name}" does not exist`);
  }
  rmSync(skillDir, { recursive: true, force: true });
}
