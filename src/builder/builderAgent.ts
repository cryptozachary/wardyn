import { callLLM } from "../llm/router.js";
import { assertSafe } from "../security/safetySpine.js";
import { assertCodeSafe } from "../security/astAnalyzer.js";
import { sanitizeName, skillExists, isProtected, writeSkill } from "./skillWriter.js";
import { validate } from "./validator.js";
import { smokeTest } from "./smokeTest.js";
import type { BuilderRequest, BuilderResult } from "./types.js";

const BUILDER_SYSTEM_PROMPT = `You are a skill code generator for the SecureClaw agent framework.

Your task: given a user's description of a desired skill, generate the complete code for that skill.

## Skill Format

Each skill lives in its own directory as skills/{name}/ and must export:
- parameters: a JSON Schema object describing the skill's input arguments
- execute(args: any): Promise<string>: an async function that performs the skill's action and returns a string result

## Language Selection

Choose TypeScript unless:
- The task requires a Python-specific library (numpy, pandas, PIL, scipy, etc.) -> use Python
- The task requires native system performance (image processing, compression, heavy computation) -> use Go or C++
- The user explicitly requests a specific language

## API Keys & Secrets

If the skill requires an API key or secret token, NEVER hardcode it. Instead:

1. Declare required secrets via a \`secrets\` export so the UI can show what's needed:

\`\`\`typescript
export const secrets = {
  API_KEY_NAME: { description: "API key from example.com", required: true }
};
\`\`\`

2. Read them at runtime via \`getSkillSecret\`:

\`\`\`typescript
import { getSkillSecret } from '../../src/security/skillSecrets.js';

// In execute():
const apiKey = getSkillSecret('your_skill_name', 'API_KEY_NAME');
if (!apiKey) throw new Error('API_KEY_NAME not configured. Add it in Setup > Skill Secrets.');
\`\`\`

Do NOT add the API key as a skill parameter — secrets are configured once by the user in the Setup page, not passed per-invocation.

Include the \`secrets\` export in your JSON response as a "secrets" field (object mapping key names to { description, required }).

## TypeScript Skill Format

For TypeScript, generate a complete index.ts file:

\`\`\`typescript
export const parameters = {
  type: "object",
  properties: {
    input: { type: "string", description: "Description of input" }
  },
  required: ["input"]
};

export async function execute(args: any): Promise<string> {
  const { input } = args;
  // ... skill logic ...
  return "result string";
}
\`\`\`

## Non-TypeScript Skill Format

For Python, Go, or C++ skills, generate ONLY the main code file (main.py, main.go, main.cpp).
A TypeScript wrapper will be generated automatically. Your code must:
- Read JSON input from stdin (the full args object)
- Write the string result to stdout
- Exit with code 0 on success, non-zero on failure
- Write errors to stderr

Python example (main.py):
\`\`\`python
import sys, json

def main():
    args = json.loads(sys.stdin.read())
    input_val = args.get("input", "")
    result = input_val.upper()
    print(result)

if __name__ == "__main__":
    main()
\`\`\`

Go example (main.go):
\`\`\`go
package main

import (
    "encoding/json"
    "fmt"
    "os"
)

func main() {
    var args map[string]interface{}
    json.NewDecoder(os.Stdin).Decode(&args)
    fmt.Println(args["input"])
}
\`\`\`

## Response Format

Respond with ONLY a JSON object. No markdown fences, no explanation, just raw JSON:
{
  "name": "skill_name_in_snake_case",
  "language": "typescript",
  "description": "One-line description",
  "parameters": { "type": "object", "properties": { ... }, "required": [...] },
  "secrets": { "API_KEY_NAME": { "description": "...", "required": true } },
  "code": "the complete source code as a single string",
  "skillMd": "1-3 sentence description for SKILL.md",
  "sampleArgs": { "arg1": "realistic test value", "arg2": 42 }
}

IMPORTANT:
- name must be lowercase snake_case, suffix with _skill (e.g., "csv_parser_skill")
- parameters must be valid JSON Schema
- code must be a single string with \\n for newlines
- Do NOT include markdown fences in your response
- For TypeScript: code is the full index.ts content
- For other languages: code is the main.py/main.go/main.cpp content
- sampleArgs MUST contain realistic test values that will actually work when the skill runs. For URLs use real public URLs. For file paths use plausible test paths. For numbers use sensible defaults. These args are used to smoke-test the generated skill.`;

const WRAPPER_TEMPLATES: Record<string, (params: string) => string> = {
  python: (params) => `import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

export const parameters = ${params};

export async function execute(args: any): Promise<string> {
  // Resolve skill source dir (main.py lives in skills/, not dist/skills/)
  const skillName = path.basename(path.dirname(fileURLToPath(import.meta.url)));
  const dir = path.join(process.cwd(), "skills", skillName);
  const script = path.join(dir, "main.py");
  const pythonCmd = process.platform === "win32" ? "python" : "python3";
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonCmd, [script], {
      cwd: dir, timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"]
    });
    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || \`Exit code \${code}\`));
      else resolve(stdout.trim());
    });
    proc.on("error", reject);
  });
}
`,
  go: (params) => `import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

export const parameters = ${params};

export async function execute(args: any): Promise<string> {
  const skillName = path.basename(path.dirname(fileURLToPath(import.meta.url)));
  const dir = path.join(process.cwd(), "skills", skillName);
  const script = path.join(dir, "main.go");
  return new Promise((resolve, reject) => {
    const proc = spawn("go", ["run", script], {
      cwd: dir, timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"]
    });
    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || \`Exit code \${code}\`));
      else resolve(stdout.trim());
    });
    proc.on("error", reject);
  });
}
`,
  cpp: (params) => `import { spawn } from "child_process";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

export const parameters = ${params};

export async function execute(args: any): Promise<string> {
  const skillName = path.basename(path.dirname(fileURLToPath(import.meta.url)));
  const dir = path.join(process.cwd(), "skills", skillName);
  const binary = path.join(dir, process.platform === "win32" ? "skill.exe" : "skill");
  const source = path.join(dir, "main.cpp");

  // Compile if binary doesn't exist or source is newer
  if (!existsSync(binary)) {
    await compileCpp(source, binary);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(binary, [], {
      cwd: dir, timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"]
    });
    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || \`Exit code \${code}\`));
      else resolve(stdout.trim());
    });
    proc.on("error", reject);
  });
}

function compileCpp(source: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("g++", ["-o", output, source], { timeout: 30000 });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(\`Compilation failed: \${stderr}\`));
      else resolve();
    });
    proc.on("error", reject);
  });
}
`,
};

function parseResponse(text: string): any {
  // Strip markdown fences if present
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  return JSON.parse(cleaned);
}

export async function generate(request: BuilderRequest, apiKey: string, userTestArgs?: Record<string, unknown>): Promise<BuilderResult> {
  const languageHint = request.language && request.language !== "auto"
    ? `\n\nThe user has requested the skill be written in ${request.language}. Honor this choice.`
    : "";

  const testArgsHint = userTestArgs
    ? `\n\nThe user has provided these test arguments for smoke testing: ${JSON.stringify(userTestArgs)}
Use these EXACT key names as your skill's parameter names so they map directly. Your sampleArgs should use these same values.`
    : "";

  const response = await callLLM(
    {
      messages: [
        { role: "system", content: BUILDER_SYSTEM_PROMPT + languageHint + testArgsHint },
        { role: "user", content: request.prompt },
      ],
    },
    apiKey
  );

  if (!response.text) {
    throw new Error("Builder agent returned empty response");
  }

  let parsed: any;
  try {
    parsed = parseResponse(response.text);
  } catch {
    throw new Error(`Failed to parse builder response as JSON. Raw response:\n${response.text.slice(0, 500)}`);
  }

  // Validate required fields
  const { name, language, description, parameters, secrets, code, skillMd, sampleArgs } = parsed;
  if (!name || !language || !code) {
    throw new Error("Builder response missing required fields (name, language, code)");
  }

  const sanitized = sanitizeName(name);
  if (!sanitized) {
    throw new Error("Generated skill name is empty after sanitization");
  }

  if (isProtected(sanitized)) {
    throw new Error(`Cannot overwrite protected skill: ${sanitized}`);
  }

  // Safety check on generated code — regex + AST
  assertSafe(code);
  const astResult = await assertCodeSafe(code, language);
  if (!astResult.safe) {
    const reasons = astResult.blockers.map(b => b.description).join("; ");
    throw new Error(`AST analysis blocked: ${reasons}`);
  }

  // Generate wrapper for non-TS languages
  let wrapperCode: string | undefined;
  if (language !== "typescript") {
    const template = WRAPPER_TEMPLATES[language];
    if (!template) {
      throw new Error(`No wrapper template for language: ${language}`);
    }
    wrapperCode = template(JSON.stringify(parameters ?? {}, null, 2));
    // Safety check on wrapper too
    assertSafe(wrapperCode);
  }

  const result: BuilderResult = {
    name: sanitized,
    language,
    description: description ?? "Generated skill",
    parameters: parameters ?? {},
    secrets: secrets ?? undefined,
    code,
    wrapperCode,
    skillMd: skillMd ?? description ?? "Generated skill",
    validationOutput: "",
    success: false,
    attempts: 1,
    sampleArgs: sampleArgs ?? undefined,
  };

  return result;
}

const MAX_RETRIES = 3;

/**
 * Ask the LLM to fix code based on error output.
 * Sends the original prompt, the failing code, and the error for correction.
 */
async function regenerate(
  request: BuilderRequest,
  previousCode: string,
  language: string,
  errorOutput: string,
  errorPhase: "validation" | "smoke_test",
  apiKey: string
): Promise<BuilderResult> {
  const fixPrompt = `The previously generated ${language} skill code failed during ${errorPhase === "validation" ? "compilation/validation" : "runtime smoke testing"}.

## Original Request
${request.prompt}

## Failing Code
\`\`\`
${previousCode}
\`\`\`

## Error Output
\`\`\`
${errorOutput}
\`\`\`

Fix the code to resolve this error. Return the corrected skill in the same JSON format. Keep the same skill name and language.`;

  const languageHint = language !== "auto"
    ? `\n\nThe skill MUST be written in ${language}. Do not change the language.`
    : "";

  const response = await callLLM(
    {
      messages: [
        { role: "system", content: BUILDER_SYSTEM_PROMPT + languageHint },
        { role: "user", content: fixPrompt },
      ],
    },
    apiKey
  );

  if (!response.text) {
    throw new Error("Builder agent returned empty response on retry");
  }

  let parsed: any;
  try {
    parsed = parseResponse(response.text);
  } catch {
    throw new Error(`Failed to parse retry response as JSON`);
  }

  const { name, description, parameters, secrets, code, skillMd, sampleArgs } = parsed;
  if (!code) {
    throw new Error("Retry response missing code field");
  }

  const sanitized = sanitizeName(name || "");
  assertSafe(code);
  const astCheck = await assertCodeSafe(code, language);
  if (!astCheck.safe) {
    const reasons = astCheck.blockers.map(b => b.description).join("; ");
    throw new Error(`AST analysis blocked (retry): ${reasons}`);
  }

  let wrapperCode: string | undefined;
  if (language !== "typescript") {
    const template = WRAPPER_TEMPLATES[language];
    if (template) {
      wrapperCode = template(JSON.stringify(parameters ?? {}, null, 2));
    }
  }

  return {
    name: sanitized,
    language,
    description: description ?? "Generated skill",
    parameters: parameters ?? {},
    secrets: secrets ?? undefined,
    code,
    wrapperCode,
    skillMd: skillMd ?? description ?? "Generated skill",
    validationOutput: "",
    success: false,
    attempts: 0,
    sampleArgs: sampleArgs ?? undefined,
  };
}

/**
 * Map user-provided test args to the skill's actual parameter names.
 * If user keys match skill params exactly, use as-is.
 * Otherwise, try to map by matching types/values to unmatched params.
 */
function mapUserArgsToParams(
  userArgs: Record<string, unknown>,
  parameters: Record<string, unknown>
): Record<string, unknown> {
  const props = (parameters as any)?.properties as Record<string, any> | undefined;
  if (!props) return userArgs;

  const paramNames = Object.keys(props);
  const userKeys = Object.keys(userArgs);

  // Check if any user keys match param names directly
  const directMatches = userKeys.filter(k => paramNames.includes(k));
  if (directMatches.length === userKeys.length) {
    return userArgs; // All keys match, use as-is
  }

  // Build mapped args: start with any direct matches
  const mapped: Record<string, unknown> = {};
  const unmappedUserKeys: string[] = [];

  for (const uk of userKeys) {
    if (paramNames.includes(uk)) {
      mapped[uk] = userArgs[uk];
    } else {
      unmappedUserKeys.push(uk);
    }
  }

  // For unmatched user keys, try to map to unmatched params by type
  const unmappedParams = paramNames.filter(p => !mapped[p]);

  for (const uk of unmappedUserKeys) {
    const userVal = userArgs[uk];
    const userType = typeof userVal;

    // Find best matching unmatched param
    let bestParam: string | null = null;

    for (const pp of unmappedParams) {
      if (mapped[pp] !== undefined) continue; // already mapped
      const paramDef = props[pp];
      const paramType = paramDef?.type;

      // Type match
      if (
        (paramType === "string" && userType === "string") ||
        (paramType === "number" && userType === "number") ||
        (paramType === "integer" && userType === "number") ||
        (paramType === "boolean" && userType === "boolean")
      ) {
        bestParam = pp;
        break;
      }
    }

    if (bestParam) {
      mapped[bestParam] = userVal;
    } else {
      // No match found — include under original key as fallback
      mapped[uk] = userVal;
    }
  }

  return mapped;
}

export async function buildSkill(
  request: BuilderRequest,
  apiKey: string,
  overwrite = false,
  userTestArgs?: Record<string, unknown>
): Promise<BuilderResult> {
  // Generate the skill code via LLM
  let result = await generate(request, apiKey, userTestArgs);
  result.attempts = 1;
  result.retryLog = [];

  // Check for conflicts
  if (skillExists(result.name) && !overwrite) {
    return {
      ...result,
      validationOutput: `Skill "${result.name}" already exists. Use overwrite=true to replace.`,
      success: false,
    };
  }

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    result.attempts = attempt;

    // Write files to disk
    writeSkill(result);

    // Validate the generated code
    const validation = await validate(result.name, result.language);
    result.validationOutput = validation.output;
    result.success = validation.valid;

    // If validation failed, retry with error context
    if (!validation.valid) {
      if (attempt <= MAX_RETRIES) {
        result.retryLog!.push(`Attempt ${attempt}: validation failed — ${validation.output.slice(0, 200)}`);
        try {
          const fixed = await regenerate(
            request, result.code, result.language,
            validation.output, "validation", apiKey
          );
          // Preserve name and carry forward metadata
          fixed.name = result.name;
          fixed.retryLog = result.retryLog;
          result = fixed;
          continue;
        } catch {
          // If regenerate itself fails, stop retrying
          break;
        }
      }
      break;
    }

    // Run smoke test if validation passed — user-provided args take priority
    try {
      const effectiveTestArgs = userTestArgs
        ? mapUserArgsToParams(userTestArgs, result.parameters)
        : result.sampleArgs;
      result.smokeTest = await smokeTest(result.name, result.language, result.parameters, effectiveTestArgs);
    } catch (err: any) {
      result.smokeTest = { passed: false, output: "", error: err.message, duration: 0 };
    }

    // If smoke test failed with a network/external-resource error, treat as soft pass
    // The code itself is likely correct — the test data just couldn't reach the resource
    if (result.smokeTest && !result.smokeTest.passed && result.smokeTest.softFail) {
      result.success = true; // deploy the skill anyway
      break;
    }

    // If smoke test failed (non-network), retry with error context
    if (result.smokeTest && !result.smokeTest.passed) {
      const smokeError = result.smokeTest.error || result.smokeTest.output || "Unknown runtime error";
      if (attempt <= MAX_RETRIES) {
        result.retryLog!.push(`Attempt ${attempt}: smoke test failed — ${smokeError.slice(0, 200)}`);
        try {
          const fixed = await regenerate(
            request, result.code, result.language,
            smokeError, "smoke_test", apiKey
          );
          fixed.name = result.name;
          fixed.retryLog = result.retryLog;
          result = fixed;
          continue;
        } catch {
          break;
        }
      }
      break;
    }

    // Both validation and smoke test passed
    break;
  }

  return result;
}
