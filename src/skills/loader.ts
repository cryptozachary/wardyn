import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";
import { createRequire } from "module";
import type { SkillMeta } from "../types.js";

const require = createRequire(import.meta.url);

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
      let parameters;
      try {
        const jsPath = path.join(skillPath, "index.js");
        const tsPath = path.join(skillPath, "index.ts");
        if (existsSync(jsPath)) ({ execute, parameters } = require(jsPath));
        else if (existsSync(tsPath)) ({ execute, parameters } = require(tsPath));
      } catch {}
      let description = `Skill at ${dir.name}`;
      const mdPath = path.join(skillPath, "SKILL.md");
      if (existsSync(mdPath)) {
        try { description = readFileSync(mdPath, "utf8").trim(); } catch {}
      }
      return { name: dir.name, description, path: skillPath, parameters, execute };
    });
}
