import axios from "axios";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export async function sendTelegramReply(chatId: string | number, text: string) {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set");
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "Markdown"
  });
}

export function extractChatId(body: any): string | number {
  return body.message?.chat?.id ?? body.message?.from?.id ?? 0;
}
