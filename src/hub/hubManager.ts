import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import type { ClawPackage, HubRegistry, HubRegistryEntry } from "./hubTypes.js";
import { writeSkill, deleteSkill, isProtected, skillExists, sanitizeName } from "../builder/skillWriter.js";
import { assertSafe } from "../security/safetySpine.js";
import { validate } from "../builder/validator.js";
import { smokeTest } from "../builder/smokeTest.js";
import { loadSkills } from "../skills/loader.js";
import type { BuilderResult } from "../builder/types.js";
import { checkSSRF } from "../security/ssrfGuard.js";
import { createSignedManifest, verifySkillCode } from "../security/skillSigning.js";

const HUB_DIR = path.join(process.cwd(), "hub");
const REGISTRY_FILE = path.join(HUB_DIR, "registry.json");

function ensureHubDir(): void {
  if (!existsSync(HUB_DIR)) mkdirSync(HUB_DIR, { recursive: true });
}

function computeChecksum(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function detectLanguage(skillDir: string): string {
  if (existsSync(path.join(skillDir, "main.py"))) return "python";
  if (existsSync(path.join(skillDir, "main.go"))) return "go";
  if (existsSync(path.join(skillDir, "main.cpp"))) return "cpp";
  return "typescript";
}

function readRegistry(): HubRegistry {
  if (!existsSync(REGISTRY_FILE)) {
    return { instanceName: "SecureClaw", packages: [] };
  }
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
  } catch {
    return { instanceName: "SecureClaw", packages: [] };
  }
}

function writeRegistry(registry: HubRegistry): void {
  ensureHubDir();
  writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), "utf8");
}

export function exportSkill(skillName: string, author: string, version = "1.0.0"): ClawPackage {
  const name = sanitizeName(skillName);
  if (!name) throw new Error("Invalid skill name");
  if (isProtected(name)) throw new Error(`Cannot export protected skill: ${name}`);

  const skillDir = path.join(process.cwd(), "skills", name);
  if (!existsSync(skillDir)) throw new Error(`Skill "${name}" not found`);

  const language = detectLanguage(skillDir);

  // Read main code
  let code: string;
  let wrapperCode: string | undefined;
  if (language === "typescript") {
    code = readFileSync(path.join(skillDir, "index.ts"), "utf8");
  } else {
    const langFiles: Record<string, string> = { python: "main.py", go: "main.go", cpp: "main.cpp" };
    code = readFileSync(path.join(skillDir, langFiles[language]), "utf8");
    const wrapperPath = path.join(skillDir, "index.ts");
    if (existsSync(wrapperPath)) {
      wrapperCode = readFileSync(wrapperPath, "utf8");
    }
  }

  // Read SKILL.md
  const mdPath = path.join(skillDir, "SKILL.md");
  const skillMd = existsSync(mdPath) ? readFileSync(mdPath, "utf8").trim() : name;

  // Get parameters from loaded skills
  const skills = loadSkills();
  const meta = skills.find(s => s.name === name);
  const parameters = meta?.parameters ?? {};

  const checksum = computeChecksum(code);
  const exportedAt = new Date().toISOString();
  const fileName = `${name}-${version}.claw`;

  // Sign the skill manifest with Ed25519
  const signed = createSignedManifest(name, version, language, code, author);

  const pkg: ClawPackage = {
    formatVersion: 1,
    name,
    language,
    description: skillMd.split("\n")[0],
    parameters,
    code,
    wrapperCode,
    skillMd,
    version,
    author,
    exportedAt,
    checksum,
    signedManifest: signed,
  };

  // Write .claw file
  ensureHubDir();
  writeFileSync(path.join(HUB_DIR, fileName), JSON.stringify(pkg, null, 2), "utf8");

  // Update registry
  const registry = readRegistry();
  const idx = registry.packages.findIndex(p => p.name === name);
  const entry: HubRegistryEntry = {
    name, version, language,
    description: pkg.description,
    author, exportedAt, fileName, checksum,
  };
  if (idx >= 0) registry.packages[idx] = entry;
  else registry.packages.push(entry);
  writeRegistry(registry);

  return pkg;
}

export async function importSkill(
  pkg: ClawPackage,
  runSmokeTestFlag = false
): Promise<{ success: boolean; error?: string }> {
  // Validate structure
  if (pkg.formatVersion !== 1) return { success: false, error: "Unsupported format version" };
  if (!pkg.name || !pkg.code || !pkg.language) return { success: false, error: "Missing required fields" };

  const name = sanitizeName(pkg.name);
  if (!name) return { success: false, error: "Invalid skill name" };
  if (isProtected(name)) return { success: false, error: `Cannot overwrite protected skill: ${name}` };

  // Verify checksum
  const expected = computeChecksum(pkg.code);
  if (pkg.checksum && pkg.checksum !== expected) {
    return { success: false, error: "Checksum mismatch -- package may be corrupted" };
  }

  // Verify Ed25519 signature if present
  if (pkg.signedManifest) {
    const sigResult = verifySkillCode(pkg.signedManifest, pkg.code);
    if (!sigResult.valid) {
      return { success: false, error: `Signature verification failed: ${sigResult.reason}` };
    }
  }

  // Safety check
  try {
    assertSafe(pkg.code);
    if (pkg.wrapperCode) assertSafe(pkg.wrapperCode);
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  // Build a BuilderResult to reuse writeSkill
  const result: BuilderResult = {
    name,
    language: pkg.language,
    description: pkg.description ?? name,
    parameters: pkg.parameters ?? {},
    code: pkg.code,
    wrapperCode: pkg.wrapperCode,
    skillMd: pkg.skillMd ?? pkg.description ?? name,
    validationOutput: "",
    success: false,
    attempts: 1,
    sampleArgs: pkg.sampleArgs,
  };

  // Write to disk
  writeSkill(result);

  // Validate
  const validation = await validate(name, pkg.language);
  if (!validation.valid) {
    try { deleteSkill(name); } catch {}
    return { success: false, error: `Validation failed: ${validation.output}` };
  }

  // Optional smoke test
  if (runSmokeTestFlag && pkg.sampleArgs) {
    try {
      const smoke = await smokeTest(name, pkg.language, pkg.parameters ?? {}, pkg.sampleArgs);
      if (!smoke.passed && !smoke.softFail) {
        try { deleteSkill(name); } catch {}
        return { success: false, error: `Smoke test failed: ${smoke.error || smoke.output}` };
      }
    } catch (err: any) {
      // Smoke test errors are non-fatal if args weren't provided
    }
  }

  return { success: true };
}

export async function importFromUrl(
  url: string,
  runSmokeTestFlag = false
): Promise<{ success: boolean; error?: string }> {
  // SSRF protection: validate URL before fetching
  const ssrf = await checkSSRF(url);
  if (!ssrf.allowed) {
    return { success: false, error: `SSRF blocked: ${ssrf.reason}` };
  }

  try {
    const res = await fetch(url);
    if (!res.ok) return { success: false, error: `HTTP ${res.status}: ${res.statusText}` };
    const pkg: ClawPackage = await res.json();
    return importSkill(pkg, runSmokeTestFlag);
  } catch (err: any) {
    return { success: false, error: `Fetch failed: ${err.message}` };
  }
}

export function listPackages(): HubRegistryEntry[] {
  return readRegistry().packages;
}

export function getPackage(name: string): ClawPackage | null {
  const registry = readRegistry();
  const entry = registry.packages.find(p => p.name === name);
  if (!entry) return null;

  const filePath = path.join(HUB_DIR, entry.fileName);
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function deletePackage(name: string): void {
  const registry = readRegistry();
  const idx = registry.packages.findIndex(p => p.name === name);
  if (idx < 0) throw new Error(`Package "${name}" not found in registry`);

  const entry = registry.packages[idx];
  const filePath = path.join(HUB_DIR, entry.fileName);
  if (existsSync(filePath)) rmSync(filePath);

  registry.packages.splice(idx, 1);
  writeRegistry(registry);
}
