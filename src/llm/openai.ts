import axios from "axios";
interface CallPayload { system: string; message: string; toolResults?: any[]; }
export async function callLLM(payload: CallPayload, apiKey: string) {
  const res = await axios.post("https://api.openai.com/v1/chat/completions", {
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: payload.system },
      { role: "user", content: payload.message },
      ...(payload.toolResults?.length ? [{ role: "system", content: JSON.stringify(payload.toolResults) }] : [])
    ]
  }, { headers: { Authorization: `Bearer ${apiKey}` } });
  const choice = res.data.choices[0].message;
  if (choice.tool_calls?.length) {
    const tc = choice.tool_calls[0];
    return { tool_call: { name: tc.function.name, args: JSON.parse(tc.function.arguments || "{}") } };
  }
  return { text: choice.content };
}
