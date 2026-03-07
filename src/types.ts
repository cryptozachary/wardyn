export type Channel = "telegram" | "discord";
export interface Message { id: string; channel: Channel; userId: string; text: string; ts: number; }
export interface ToolCall { name: string; args: Record<string, unknown>; }
export interface ToolResult { name: string; output: string; error?: string; }
export interface SkillMeta { name: string; description: string; path: string; execute?: (args: any, meta?: Message) => Promise<string>; }
