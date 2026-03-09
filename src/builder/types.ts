export interface BuilderRequest {
  prompt: string;
  language?: "auto" | "typescript" | "python" | "go" | "cpp";
}

export interface BuilderResult {
  name: string;
  language: string;
  description: string;
  parameters: Record<string, unknown>;
  code: string;
  wrapperCode?: string;
  skillMd: string;
  validationOutput: string;
  success: boolean;
}

export interface ValidationResult {
  valid: boolean;
  output: string;
}
