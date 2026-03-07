import axios from "axios";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

export async function sendDiscordReply(channelId: string, text: string) {
  if (!BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN not set");
  await axios.post(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    content: text
  }, {
    headers: { Authorization: `Bot ${BOT_TOKEN}` }
  });
}

export function extractChannelId(body: any): string {
  return body.channel_id ?? "";
}
