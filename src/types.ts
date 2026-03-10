export type Channel = "telegram" | "discord" | "websocket" | "heartbeat" | "slack";
export interface Message { id: string; channel: Channel; userId: string; text: string; ts: number; }
export interface ToolCall { name: string; args: Record<string, unknown>; }
export interface ToolResult { name: string; output: string; error?: string; }
export interface SkillSecretDef { description: string; required?: boolean; }
export interface SkillMeta { name: string; description: string; path: string; parameters?: Record<string, unknown>; secrets?: Record<string, SkillSecretDef>; execute?: (args: any, meta?: Message) => Promise<string>; }

export type StreamEvent =
  | { type: "thinking"; iteration: number }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; output: string; error?: string }
  | { type: "final"; text: string | null }
  | { type: "error"; error: string };

export type OnStream = (event: StreamEvent) => void;
