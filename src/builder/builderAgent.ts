import { callLLM } from "../llm/router.js";
import { assertSafe } from "../security/safetySpine.js";
import { sanitizeName, skillExists, isProtected, writeSkill } from "./skillWriter.js";
import { validate } from "./validator.js";
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
  "code": "the complete source code as a single string",
  "skillMd": "1-3 sentence description for SKILL.md"
}

IMPORTANT:
- name must be lowercase snake_case, suffix with _skill (e.g., "csv_parser_skill")
- parameters must be valid JSON Schema
- code must be a single string with \\n for newlines
- Do NOT include markdown fences in your response
- For TypeScript: code is the full index.ts content
- For other languages: code is the main.py/main.go/main.cpp content`;

const WRAPPER_TEMPLATES: Record<string, (params: string) => string> = {
  python: (params) => `import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

export const parameters = ${params};

export async function execute(args: any): Promise<string> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(dir, "main.py");
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [script], {
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
  const dir = path.dirname(fileURLToPath(import.meta.url));
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
  const dir = path.dirname(fileURLToPath(import.meta.url));
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

export async function generate(request: BuilderRequest, apiKey: string): Promise<BuilderResult> {
  const languageHint = request.language && request.language !== "auto"
    ? `\n\nThe user has requested the skill be written in ${request.language}. Honor this choice.`
    : "";

  const response = await callLLM(
    {
      messages: [
        { role: "system", content: BUILDER_SYSTEM_PROMPT + languageHint },
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
  const { name, language, description, parameters, code, skillMd } = parsed;
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

  // Safety check on generated code
  assertSafe(code);

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
    code,
    wrapperCode,
    skillMd: skillMd ?? description ?? "Generated skill",
    validationOutput: "",
    success: false,
  };

  return result;
}

export async function buildSkill(
  request: BuilderRequest,
  apiKey: string,
  overwrite = false
): Promise<BuilderResult> {
  // Generate the skill code via LLM
  const result = await generate(request, apiKey);

  // Check for conflicts
  if (skillExists(result.name) && !overwrite) {
    return {
      ...result,
      validationOutput: `Skill "${result.name}" already exists. Use overwrite=true to replace.`,
      success: false,
    };
  }

  // Write files to disk
  writeSkill(result);

  // Validate the generated code
  const validation = await validate(result.name, result.language);
  result.validationOutput = validation.output;
  result.success = validation.valid;

  return result;
}
