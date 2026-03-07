import { readdirSync } from "fs"; import path from "path"; import type { SkillMeta } from "../types.js";
export function loadSkills(root = path.join(process.cwd(), "skills")): SkillMeta[] {
  return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(dir => {
    const skillPath = path.join(root, dir.name); let execute; try { ({ execute } = require(path.join(skillPath, "index.ts"))); } catch {}
    return { name: dir.name, description: `Skill at ${dir.name}`, path: skillPath, execute };
  });
}
