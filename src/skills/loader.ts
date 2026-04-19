import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";
import { createRequire } from "module";
import type { SkillMeta } from "../types.js";

const require = createRequire(import.meta.url);

function resolveSkillsRoot() {
  // Packaged Electron sets SKILLS_ROOT to the extraResources path because
  // process.cwd() points at DATA_DIR (user-writable state), not at the
  // read-only resource tree that ships with the installer.
  if (process.env.SKILLS_ROOT && existsSync(process.env.SKILLS_ROOT)) {
    return process.env.SKILLS_ROOT;
  }
  const distSkills = path.join(process.cwd(), "dist", "skills");
  return existsSync(distSkills) ? distSkills : path.join(process.cwd(), "skills");
}

export function loadSkills(root = resolveSkillsRoot()): SkillMeta[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(dir => {
      const skillPath = path.join(root, dir.name);
      let execute;
      let parameters;
      let secrets;
      try {
        const jsPath = path.join(skillPath, "index.js");
        const tsPath = path.join(skillPath, "index.ts");
        if (existsSync(jsPath)) ({ execute, parameters, secrets } = require(jsPath));
        else if (existsSync(tsPath)) ({ execute, parameters, secrets } = require(tsPath));
      } catch (err: any) {
        // Surface load failures so skills don't silently register as "Tool not found".
        console.error(`[skills] failed to load ${dir.name}: ${err?.message ?? err}`);
      }
      let description = `Skill at ${dir.name}`;
      const mdPath = path.join(skillPath, "SKILL.md");
      if (existsSync(mdPath)) {
        try { description = readFileSync(mdPath, "utf8").trim(); } catch {}
      }
      return { name: dir.name, description, path: skillPath, parameters, secrets, execute };
    });
}
