export interface BuilderRequest {
  prompt: string;
  language?: "auto" | "typescript" | "python" | "go" | "cpp";
}

export interface SkillSecretDef {
  description: string;
  required?: boolean;
}

export interface BuilderResult {
  name: string;
  language: string;
  description: string;
  parameters: Record<string, unknown>;
  secrets?: Record<string, SkillSecretDef>;
  code: string;
  wrapperCode?: string;
  skillMd: string;
  validationOutput: string;
  success: boolean;
  smokeTest?: SmokeTestResult;
  attempts: number;
  retryLog?: string[];
  sampleArgs?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  output: string;
}

export interface SmokeTestResult {
  passed: boolean;
  output: string;
  error?: string;
  duration: number;
  /** True when the failure is likely due to external resources (network, URLs), not code bugs */
  softFail?: boolean;
}
