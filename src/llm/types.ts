export interface ToolDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CallPayload {
  messages: ChatMessage[];
  tools?: ToolDef[];
  thinkingLevel?: ThinkingLevel;
}

export interface LLMUsage {
  promptTokens?: number;
  outputTokens?: number;
  /** Provider-reported cost in USD when available. */
  costUsd?: number;
  /** Model string echoed from the provider response, if known. */
  model?: string;
}

export interface LLMResponse {
  tool_calls: any[] | null;
  text: string | null;
  usage?: LLMUsage;
}

export interface LLMProvider {
  name: string;
  callLLM(payload: CallPayload, apiKey: string): Promise<LLMResponse>;
}
