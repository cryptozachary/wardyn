import axios from "axios";

interface ToolDef {
  name: string;
  description?: string;
}

interface CallPayload {
  system: string;
  message: string;
  toolResults?: any[];
  tools?: ToolDef[];
}

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export async function callLLM(payload: CallPayload, apiKey: string) {
  try {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: MODEL,
      messages: [
        { role: "system", content: payload.system },
        { role: "user", content: payload.message },
        ...(payload.toolResults?.length ? [{ role: "system", content: JSON.stringify(payload.toolResults) }] : [])
      ],
      tools: payload.tools?.map(t => ({
        type: "function",
      function: {
        name: t.name,
        description: t.description ?? "Skill tool",
        parameters: { type: "object", properties: {}, additionalProperties: true }
      }
    }))
  }, { headers: { Authorization: `Bearer ${apiKey}` } });
    const choice = res.data.choices[0].message;
    if (choice.tool_calls?.length) {
      const calls = choice.tool_calls.map((tc: any) => ({
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments || "{}")
      }));
      return { tool_calls: calls };
    }
    return { text: choice.content };
  } catch (err: any) {
    const msg = err.response?.data?.error?.message || err.message || "LLM call failed";
    throw new Error(msg);
  }
}
