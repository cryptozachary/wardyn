import axios from "axios";

interface ToolDef {
  name: string;
  description?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
}

interface CallPayload {
  messages: ChatMessage[];
  tools?: ToolDef[];
}

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export async function callLLM(payload: CallPayload, apiKey: string) {
  try {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: MODEL,
      messages: payload.messages,
      tools: payload.tools?.length ? payload.tools.map(t => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "Skill tool",
          parameters: { type: "object", properties: {}, additionalProperties: true }
        }
      })) : undefined
    }, { headers: { Authorization: `Bearer ${apiKey}` } });
    const choice = res.data.choices[0].message;
    if (choice.tool_calls?.length) {
      return { tool_calls: choice.tool_calls, text: null };
    }
    return { tool_calls: null, text: choice.content };
  } catch (err: any) {
    const msg = err.response?.data?.error?.message || err.message || "LLM call failed";
    throw new Error(msg);
  }
}
