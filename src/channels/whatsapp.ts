/**
 * WhatsApp channel via Baileys.
 *
 * First run: prints a QR code in the terminal — scan with WhatsApp on your
 * phone (Settings → Linked Devices). Auth state is persisted under
 * data/whatsapp-auth/ so subsequent runs reconnect silently.
 *
 * Messages go through the same agent loop as the other channels. DM sender
 * pairing is enforced by the pairingGuard.
 */
import path from "path";
import { mkdirSync } from "fs";
import { runAgentLoop } from "../orchestrator/agentLoop.js";
import type { Message, SkillMeta } from "../types.js";
import { checkPairing, pairingMessage } from "../security/pairingGuard.js";

const AUTH_DIR = path.join(process.cwd(), "data", "whatsapp-auth");
const SELF_ECHO_GUARD = new Set<string>();

let sock: any = null;
let running = false;

export function isWhatsappRunning(): boolean {
  return running && sock != null;
}

export async function sendWhatsappReply(jid: string, text: string): Promise<void> {
  if (!sock) throw new Error("WhatsApp not connected");
  await sock.sendMessage(jid, { text });
}

export async function startWhatsapp(
  skills: SkillMeta[],
  getProviderKey: () => string
): Promise<void> {
  if (running) return;
  mkdirSync(AUTH_DIR, { recursive: true });

  // Dynamic import — Baileys is ESM-only and heavy; skip cleanly if not installed.
  let baileys: any;
  try {
    baileys = await import("baileys");
  } catch (err: any) {
    console.warn(`[whatsapp] module not installed — skipping (${err.message})`);
    return;
  }

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
  } = baileys;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u: any) => {
    const { connection, lastDisconnect } = u;
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.warn(`[whatsapp] disconnected code=${code} reconnect=${shouldReconnect}`);
      running = false;
      sock = null;
      if (shouldReconnect) setTimeout(() => startWhatsapp(skills, getProviderKey), 5000);
    } else if (connection === "open") {
      running = true;
      console.log("[whatsapp] connected");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }: any) => {
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue;
        const jid: string = m.key.remoteJid;
        if (!jid) continue;

        // Self-echo guard: don't process our own messages if they loop back.
        const msgId = m.key.id;
        if (msgId && SELF_ECHO_GUARD.has(msgId)) continue;

        const text: string =
          m.message.conversation
          || m.message.extendedTextMessage?.text
          || m.message.imageMessage?.caption
          || m.message.videoMessage?.caption
          || "";
        if (!text.trim()) continue;

        const pairing = checkPairing("whatsapp", jid);
        if (!pairing.approved) {
          try { await sock.sendMessage(jid, { text: pairingMessage("whatsapp", pairing.code!) }); } catch {}
          continue;
        }

        const msg: Message = {
          id: msgId ?? String(Date.now()),
          channel: "whatsapp",
          userId: jid,
          text,
          ts: Date.now(),
        };

        const result = await runAgentLoop(msg, skills, getProviderKey(), {
          sessionId: `whatsapp:${jid}`,
        });
        if (result.final) {
          await sock.sendMessage(jid, { text: result.final });
        }
      } catch (err: any) {
        console.error(`[whatsapp] handler error: ${err.message}`);
      }
    }
  });
}

export async function stopWhatsapp(): Promise<void> {
  if (sock) {
    try { sock.end?.(); } catch {}
    sock = null;
  }
  running = false;
}
