import { readdirSync, existsSync } from "fs";
import path from "path";
import type { SkillMeta } from "../types.js";

function resolveSkillsRoot() {
  const distSkills = path.join(process.cwd(), "dist", "skills");
  return existsSync(distSkills) ? distSkills : path.join(process.cwd(), "skills");
}

export function loadSkills(root = resolveSkillsRoot()): SkillMeta[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(dir => {
      const skillPath = path.join(root, dir.name);
      let execute;
      try {
        const jsPath = path.join(skillPath, "index.js");
        const tsPath = path.join(skillPath, "index.ts");
        if (existsSync(jsPath)) ({ execute } = require(jsPath));
        else if (existsSync(tsPath)) ({ execute } = require(tsPath));
      } catch {}
      return { name: dir.name, description: `Skill at ${dir.name}`, path: skillPath, execute };
    });
}
