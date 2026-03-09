import axios from "axios";
import { loadChannelConfig } from "./channelConfig.js";

function getToken(): string {
  const cfg = loadChannelConfig();
  return cfg.telegram?.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
}

export async function sendTelegramReply(chatId: string | number, text: string) {
  const token = getToken();
  if (!token) throw new Error("Telegram bot token not configured");
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "Markdown"
  });
}

export function extractChatId(body: any): string | number {
  return body.message?.chat?.id ?? body.message?.from?.id ?? 0;
}
