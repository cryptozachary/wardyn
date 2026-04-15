import { Client, GatewayIntentBits, Message as DiscordMessage, Partials } from "discord.js";
import { loadChannelConfig } from "./channelConfig.js";
import { Message, SkillMeta } from "../types.js";
import { runAgentLoop } from "../orchestrator/agentLoop.js";
import { createPublicKey, verify as cryptoVerify } from "crypto";

let client: Client | null = null;

function getToken(): string {
  const cfg = loadChannelConfig();
  return cfg.discord?.botToken || process.env.DISCORD_BOT_TOKEN || "";
}

/**
 * Start the Discord gateway bot.
 * Connects to Discord via WebSocket and listens for messages.
 */
export function startDiscordBot(
  skills: SkillMeta[],
  getProviderKey: () => string
): void {
  const token = getToken();
  if (!token) {
    console.log("Discord: no bot token configured, skipping gateway connection");
    return;
  }

  if (client) {
    console.log("Discord: bot already running");
    return;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel], // needed for DMs
  });

  client.on("ready", () => {
    console.log(`Discord: bot connected as ${client!.user?.tag}`);
  });

  client.on("messageCreate", async (msg: DiscordMessage) => {
    // Ignore bot messages (including our own)
    if (msg.author.bot) return;

    // Only respond when mentioned or in DMs
    const isDM = !msg.guild;
    const isMentioned = client!.user && msg.mentions.has(client!.user);
    if (!isDM && !isMentioned) return;

    // Strip the bot mention from the text
    let text = msg.content;
    if (client!.user) {
      text = text.replace(new RegExp(`<@!?${client!.user.id}>`, "g"), "").trim();
    }

    if (!text) return;

    const normalized: Message = {
      id: msg.id,
      channel: "discord",
      userId: msg.author.id,
      text,
      ts: Date.now(),
    };

    try {
      // Show typing indicator while processing
      if ("sendTyping" in msg.channel) await msg.channel.sendTyping();

      const key = getProviderKey();
      const result = await runAgentLoop(normalized, skills, key, {
        sessionId: "default",
      });

      if (result.final) {
        // Discord has a 2000 char limit per message — split if needed
        const chunks = splitMessage(result.final, 2000);
        for (const chunk of chunks) {
          await msg.reply(chunk);
        }
      }
    } catch (err: any) {
      console.error("Discord: error processing message:", err.message);
      try {
        await msg.reply("Sorry, I encountered an error processing your message.");
      } catch {}
    }
  });

  client.login(token).catch((err) => {
    console.error("Discord: failed to login:", err.message);
    client = null;
  });
}

/**
 * Stop the Discord bot gracefully.
 */
export function stopDiscordBot(): void {
  if (client) {
    client.destroy();
    client = null;
    console.log("Discord: bot disconnected");
  }
}

/**
 * Check if the Discord bot is currently connected.
 */
export function isDiscordBotRunning(): boolean {
  return client !== null && client.isReady();
}

/**
 * Split a message into chunks respecting Discord's character limit.
 */
function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.5) splitAt = limit; // no good newline, hard split
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

// Legacy exports kept for the webhook route (can be removed once fully migrated)
export async function sendDiscordReply(channelId: string, text: string) {
  // Use discord.js client if available, otherwise fall back to REST
  if (client && client.isReady()) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && channel.isTextBased() && "send" in channel) {
        const chunks = splitMessage(text, 2000);
        for (const chunk of chunks) {
          await (channel as any).send(chunk);
        }
        return;
      }
    } catch {}
  }

  // REST fallback
  const { default: axios } = await import("axios");
  const token = getToken();
  if (!token) throw new Error("Discord bot token not configured");
  await axios.post(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    content: text
  }, {
    headers: { Authorization: `Bot ${token}` }
  });
}

export function extractChannelId(body: any): string {
  return body.channel_id ?? "";
}

/**
 * Verify an Ed25519 signature on a Discord interaction webhook.
 * Discord signs `timestamp + rawBody` with the application's public key.
 * Returns false when the public key is missing or signature does not verify.
 */
export function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  rawBody: string,
): boolean {
  try {
    if (!publicKeyHex || !signatureHex || !timestamp || !rawBody) return false;
    const pubRaw = Buffer.from(publicKeyHex, "hex");
    if (pubRaw.length !== 32) return false;
    // Wrap raw 32-byte key in a DER SubjectPublicKeyInfo for Ed25519.
    const der = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      pubRaw,
    ]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    const sig = Buffer.from(signatureHex, "hex");
    const data = Buffer.from(timestamp + rawBody, "utf8");
    return cryptoVerify(null, data, key, sig);
  } catch {
    return false;
  }
}
