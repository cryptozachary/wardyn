import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["set", "list", "delete", "check"],
      description: "Reminder action: set (create), list (show all), delete (remove by id), check (return due reminders)",
    },
    message: { type: "string", description: "Reminder message (required for set)" },
    dueIn: { type: "string", description: "When to remind — e.g. '30m', '2h', '1d', '3h30m' (required for set)" },
    id: { type: "string", description: "Reminder ID (required for delete)" },
  },
  required: ["action"],
};

/* ────────────────────── types ────────────────────── */

interface Reminder {
  id: string;
  message: string;
  createdAt: string;
  dueAt: string;
  fired: boolean;
}

interface ReminderStore {
  reminders: Reminder[];
}

/* ────────────────────── file path ────────────────────── */

const STORE_PATH = path.join(process.cwd(), "config", "reminders.json");

async function loadStore(): Promise<ReminderStore> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { reminders: [] };
  }
}

async function saveStore(store: ReminderStore): Promise<void> {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

/* ────────────────────── duration parser ────────────────────── */

function parseDuration(input: string): number {
  const str = input.toLowerCase().trim();
  let totalMs = 0;

  const patterns: [RegExp, number][] = [
    [/(\d+)\s*d/g, 86400000],    // days
    [/(\d+)\s*h/g, 3600000],     // hours
    [/(\d+)\s*m(?!s)/g, 60000],  // minutes (not ms)
    [/(\d+)\s*s/g, 1000],        // seconds
  ];

  for (const [re, mult] of patterns) {
    let match;
    while ((match = re.exec(str)) !== null) {
      totalMs += parseInt(match[1], 10) * mult;
    }
  }

  if (totalMs === 0) {
    // Try plain number as minutes
    const num = parseInt(str, 10);
    if (!isNaN(num) && num > 0) totalMs = num * 60000;
  }

  return totalMs;
}

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const { action } = args;

  switch (action) {
    case "set": {
      const { message, dueIn } = args;
      if (!message || typeof message !== "string") {
        return JSON.stringify({ status: "error", error: "message is required" });
      }
      if (!dueIn || typeof dueIn !== "string") {
        return JSON.stringify({ status: "error", error: "dueIn is required (e.g. '30m', '2h', '1d')" });
      }
      const ms = parseDuration(dueIn);
      if (ms <= 0) {
        return JSON.stringify({ status: "error", error: `Could not parse duration: "${dueIn}". Use formats like 30m, 2h, 1d, 3h30m` });
      }

      const now = new Date();
      const dueAt = new Date(now.getTime() + ms);
      const reminder: Reminder = {
        id: crypto.randomBytes(4).toString("hex"),
        message,
        createdAt: now.toISOString(),
        dueAt: dueAt.toISOString(),
        fired: false,
      };

      const store = await loadStore();
      store.reminders.push(reminder);
      await saveStore(store);

      return JSON.stringify({
        status: "ok",
        action: "set",
        id: reminder.id,
        message: reminder.message,
        dueAt: reminder.dueAt,
        dueIn: formatDuration(ms),
      });
    }

    case "list": {
      const store = await loadStore();
      const active = store.reminders.filter((r) => !r.fired);
      const now = Date.now();
      const items = active.map((r) => ({
        id: r.id,
        message: r.message,
        dueAt: r.dueAt,
        overdue: new Date(r.dueAt).getTime() < now,
        timeLeft: formatDuration(Math.max(0, new Date(r.dueAt).getTime() - now)),
      }));
      return JSON.stringify({ status: "ok", action: "list", count: items.length, reminders: items });
    }

    case "delete": {
      const { id } = args;
      if (!id) return JSON.stringify({ status: "error", error: "id is required for delete" });
      const store = await loadStore();
      const idx = store.reminders.findIndex((r) => r.id === id);
      if (idx < 0) return JSON.stringify({ status: "error", error: `Reminder ${id} not found` });
      store.reminders.splice(idx, 1);
      await saveStore(store);
      return JSON.stringify({ status: "ok", action: "delete", id });
    }

    case "check": {
      // Return all due (unfired) reminders and mark them as fired
      const store = await loadStore();
      const now = Date.now();
      const due: Reminder[] = [];
      for (const r of store.reminders) {
        if (!r.fired && new Date(r.dueAt).getTime() <= now) {
          r.fired = true;
          due.push(r);
        }
      }
      if (due.length > 0) await saveStore(store);

      // Also clean up old fired reminders (older than 24h)
      const cutoff = now - 86400000;
      store.reminders = store.reminders.filter(
        (r) => !r.fired || new Date(r.dueAt).getTime() > cutoff,
      );
      await saveStore(store);

      return JSON.stringify({
        status: "ok",
        action: "check",
        due: due.map((r) => ({ id: r.id, message: r.message, dueAt: r.dueAt })),
      });
    }

    default:
      return JSON.stringify({ status: "error", error: `Unknown action: ${action}. Use: set, list, delete, check` });
  }
}

/* ────────────────────── helpers ────────────────────── */

function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const parts: string[] = [];
  const d = Math.floor(ms / 86400000); if (d) parts.push(`${d}d`);
  const h = Math.floor((ms % 86400000) / 3600000); if (h) parts.push(`${h}h`);
  const m = Math.floor((ms % 3600000) / 60000); if (m) parts.push(`${m}m`);
  if (parts.length === 0) {
    const s = Math.floor(ms / 1000); parts.push(`${s}s`);
  }
  return parts.join(" ");
}
