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

export interface LLMResponse {
  tool_calls: any[] | null;
  text: string | null;
}

export interface LLMProvider {
  name: string;
  callLLM(payload: CallPayload, apiKey: string): Promise<LLMResponse>;
}
