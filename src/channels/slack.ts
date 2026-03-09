import axios from "axios";
import crypto from "crypto";
import { loadChannelConfig } from "./channelConfig.js";

function getToken(): string {
  const cfg = loadChannelConfig();
  return cfg.slack?.botToken || process.env.SLACK_BOT_TOKEN || "";
}

export function getSlackSigningSecret(): string {
  const cfg = loadChannelConfig();
  return cfg.slack?.signingSecret || process.env.SLACK_SIGNING_SECRET || "";
}

export async function sendSlackReply(channelId: string, text: string) {
  const token = getToken();
  if (!token) throw new Error("Slack bot token not configured");
  await axios.post("https://slack.com/api/chat.postMessage", {
    channel: channelId,
    text,
  }, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
}

export function extractSlackChannelId(body: any): string {
  return body.event?.channel ?? "";
}

export function isSlackBotMessage(body: any): boolean {
  return !!(body.event?.bot_id || body.event?.subtype === "bot_message");
}

export function isSlackUrlVerification(body: any): boolean {
  return body.type === "url_verification";
}

export function isSlackMessageEvent(body: any): boolean {
  return body.type === "event_callback" && body.event?.type === "message";
}

export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string
): boolean {
  if (!signingSecret || !timestamp || !signature) return false;
  // Reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;
  const baseString = `v0:${timestamp}:${rawBody}`;
  const computed = "v0=" + crypto.createHmac("sha256", signingSecret).update(baseString).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}
