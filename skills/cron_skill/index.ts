import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["create", "list", "delete", "pause", "resume", "check"],
      description:
        "Cron action: create (schedule a recurring task), list (show all jobs), delete (remove by id), pause/resume (toggle active), check (return jobs due now)",
    },
    name: { type: "string", description: "Human-readable job name (required for create)" },
    schedule: {
      type: "string",
      description:
        "Cron schedule expression (5 fields: min hour dom month dow) or shorthand: @hourly, @daily, @weekly, @monthly. Required for create.",
    },
    timezone: {
      type: "string",
      description: "IANA timezone for this job (e.g. 'America/New_York', 'Europe/London'). Default: server local time.",
    },
    taskType: {
      type: "string",
      enum: ["skill_call", "message"],
      description: "What to do when triggered: skill_call (invoke a skill) or message (return a reminder message). Default: message",
    },
    skillName: { type: "string", description: "Skill to call when taskType=skill_call" },
    skillArgs: { type: "object", description: "Arguments to pass to the skill (max 10KB serialized)" },
    message: { type: "string", description: "Message to return when taskType=message" },
    id: { type: "string", description: "Job ID (required for delete/pause/resume)" },
  },
  required: ["action"],
};

/* ────────────────────── types ────────────────────── */

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  timezone?: string;
  taskType: "skill_call" | "message";
  skillName?: string;
  skillArgs?: Record<string, any>;
  message?: string;
  active: boolean;
  createdAt: string;
  lastRun: string | null;
  nextRun: string;
  runCount: number;
}

interface CronStore {
  jobs: CronJob[];
}

/* ────────────────────── constants ────────────────────── */

const STORE_PATH = path.join(process.cwd(), "config", "cron_jobs.json");
const MAX_JOBS = 50;
const MAX_SKILL_ARGS_SIZE = 10240; // 10KB
const MAX_NAME_LENGTH = 100;
const MAX_MESSAGE_LENGTH = 2000;

const SHORTHANDS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@midnight": "0 0 * * *",
};

// Known skill names — loaded lazily on first create with taskType=skill_call
let knownSkills: Set<string> | null = null;

function getKnownSkills(): Set<string> {
  if (knownSkills) return knownSkills;
  try {
    const distSkills = path.join(process.cwd(), "dist", "skills");
    const srcSkills = path.join(process.cwd(), "skills");
    const { readdirSync, existsSync } = require("fs");
    const root = existsSync(distSkills) ? distSkills : srcSkills;
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d: any) => d.isDirectory())
      .map((d: any) => d.name);
    knownSkills = new Set(dirs);
  } catch {
    knownSkills = new Set();
  }
  return knownSkills;
}

/* ────────────────────── atomic persistence ────────────────────── */

let storeLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = storeLock;
  let resolve: () => void;
  storeLock = new Promise<void>((r) => (resolve = r));
  return prev.then(fn).finally(() => resolve!());
}

async function loadStore(): Promise<CronStore> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { jobs: [] };
  }
}

async function saveStore(store: CronStore): Promise<void> {
  const dir = path.dirname(STORE_PATH);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.cron_tmp_${crypto.randomBytes(8).toString("hex")}`);
  try {
    await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), "utf8");
    await fs.rename(tmpPath, STORE_PATH);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/* ────────────────────── cron parser (hardened) ────────────────────── */

interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

// Strict token regex: only digits, *, -, /, , allowed
const VALID_FIELD = /^[\d\*\-\/,]+$/;

function parseField(field: string, min: number, max: number): number[] {
  if (!VALID_FIELD.test(field)) {
    throw new Error(`Invalid cron field: "${field}" — only digits, *, -, /, and , allowed`);
  }

  const values: Set<number> = new Set();

  for (const part of field.split(",")) {
    if (!part) throw new Error(`Empty segment in cron field: "${field}"`);

    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const range = stepMatch ? stepMatch[1] : part;

    // Fix #1: prevent step=0 which causes infinite loops
    if (step < 1) {
      throw new Error(`Invalid step value: ${step} in "${part}" — step must be >= 1`);
    }

    if (range === "*") {
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (range.includes("-")) {
      const rangeParts = range.split("-");
      if (rangeParts.length !== 2) throw new Error(`Invalid range: "${range}"`);
      const s = parseInt(rangeParts[0], 10);
      const e = parseInt(rangeParts[1], 10);
      if (isNaN(s) || isNaN(e)) throw new Error(`Non-numeric range: "${range}"`);
      if (s < min || e > max) throw new Error(`Range ${s}-${e} out of bounds (${min}-${max})`);
      if (s > e) throw new Error(`Invalid range: ${s} > ${e} in "${range}"`);
      for (let i = s; i <= e; i += step) values.add(i);
    } else {
      const num = parseInt(range, 10);
      if (isNaN(num)) throw new Error(`Non-numeric token: "${range}"`);
      if (num < min || num > max) throw new Error(`Value ${num} out of bounds (${min}-${max})`);
      values.add(num);
    }
  }

  const result = [...values].sort((a, b) => a - b);
  if (result.length === 0) {
    throw new Error(`Cron field "${field}" produced no valid values`);
  }
  return result;
}

function parseCron(expr: string): CronFields {
  const resolved = SHORTHANDS[expr.toLowerCase()] || expr;
  const parts = resolved.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: "${expr}" — need exactly 5 fields (min hour dom month dow)`);
  }

  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    daysOfWeek: parseField(parts[4], 0, 6),
  };
}

/* ────────────────────── timezone-aware date helpers ────────────────────── */

/**
 * Get the current date components in a specific timezone.
 * Falls back to local time if timezone is invalid.
 */
function dateInTz(date: Date, timezone?: string): {
  year: number; month: number; day: number; hour: number; minute: number; dow: number;
} {
  if (!timezone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      dow: date.getDay(),
    };
  }

  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

    return {
      year: parseInt(get("year"), 10),
      month: parseInt(get("month"), 10),
      day: parseInt(get("day"), 10),
      hour: parseInt(get("hour"), 10),
      minute: parseInt(get("minute"), 10),
      dow: dowMap[get("weekday")] ?? date.getDay(),
    };
  } catch {
    // Invalid timezone — fall back to local
    return dateInTz(date);
  }
}

function matchesFields(fields: CronFields, dt: ReturnType<typeof dateInTz>): boolean {
  return (
    fields.months.includes(dt.month) &&
    fields.daysOfMonth.includes(dt.day) &&
    fields.daysOfWeek.includes(dt.dow) &&
    fields.hours.includes(dt.hour) &&
    fields.minutes.includes(dt.minute)
  );
}

/** Find the next occurrence after `after` date, respecting timezone */
function nextOccurrence(expr: string, after: Date, timezone?: string): Date {
  const fields = parseCron(expr);
  const d = new Date(after.getTime() + 60000); // at least 1 min in future
  d.setSeconds(0, 0);

  // Scan up to 366 days out
  for (let i = 0; i < 527040; i++) {
    const dt = dateInTz(d, timezone);
    if (matchesFields(fields, dt)) {
      return d;
    }
    d.setTime(d.getTime() + 60000);
  }

  throw new Error("Could not compute next run within 366 days — check schedule expression");
}

/* ────────────────────── validation helpers ────────────────────── */

function validateTimezone(tz: string): void {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`Invalid timezone: "${tz}". Use IANA format (e.g. America/New_York)`);
  }
}

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { action } = args;

  try {
    switch (action) {
      case "create":
        return await withLock(() => handleCreate(args, start));
      case "list":
        return await handleList(start);
      case "delete":
        return await withLock(() => handleDelete(args, start));
      case "pause":
        return await withLock(() => handleToggle(args, false, start));
      case "resume":
        return await withLock(() => handleToggle(args, true, start));
      case "check":
        return await withLock(() => handleCheck(start));
      default:
        throw new Error(`Unknown action: ${action}. Use: create, list, delete, pause, resume, check`);
    }
  } catch (err: any) {
    return JSON.stringify({ status: "error", action, error: err.message, elapsedMs: Date.now() - start });
  }
}

async function handleCreate(args: any, start: number): Promise<string> {
  const { name, schedule, timezone, taskType = "message", skillName, skillArgs, message } = args;

  // Input validation
  if (!name || typeof name !== "string") throw new Error("name is required");
  if (name.length > MAX_NAME_LENGTH) throw new Error(`name too long (max ${MAX_NAME_LENGTH} chars)`);
  if (!schedule || typeof schedule !== "string") throw new Error("schedule is required");

  // Fix #7: Strict cron validation (parseCron now validates thoroughly)
  parseCron(schedule);

  // Fix #3: Timezone validation
  if (timezone) validateTimezone(timezone);

  // Fix #5: Validate skill targets
  if (taskType === "skill_call") {
    if (!skillName) throw new Error("skillName is required when taskType is skill_call");
    const skills = getKnownSkills();
    if (skills.size > 0 && !skills.has(skillName)) {
      throw new Error(`Unknown skill: "${skillName}". Available: ${[...skills].sort().join(", ")}`);
    }
  }
  if (taskType === "message" && !message) {
    throw new Error("message is required when taskType is message");
  }

  // Fix #6: Guardrails
  if (message && message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`message too long (max ${MAX_MESSAGE_LENGTH} chars)`);
  }
  if (skillArgs) {
    const argsSize = JSON.stringify(skillArgs).length;
    if (argsSize > MAX_SKILL_ARGS_SIZE) {
      throw new Error(`skillArgs too large (${(argsSize / 1024).toFixed(1)}KB, max ${MAX_SKILL_ARGS_SIZE / 1024}KB)`);
    }
  }

  const store = await loadStore();

  if (store.jobs.length >= MAX_JOBS) {
    throw new Error(`Job limit reached (max ${MAX_JOBS}). Delete unused jobs first.`);
  }

  const now = new Date();
  const job: CronJob = {
    id: crypto.randomBytes(4).toString("hex"),
    name,
    schedule: SHORTHANDS[schedule.toLowerCase()] || schedule,
    ...(timezone && { timezone }),
    taskType,
    ...(skillName && { skillName }),
    ...(skillArgs && { skillArgs }),
    ...(message && { message }),
    active: true,
    createdAt: now.toISOString(),
    lastRun: null,
    nextRun: nextOccurrence(schedule, now, timezone).toISOString(),
    runCount: 0,
  };

  store.jobs.push(job);
  await saveStore(store);

  return JSON.stringify({
    status: "ok",
    action: "create",
    job: { id: job.id, name: job.name, schedule: job.schedule, timezone: job.timezone, nextRun: job.nextRun },
    elapsedMs: Date.now() - start,
  });
}

async function handleList(start: number): Promise<string> {
  const store = await loadStore();
  const jobs = store.jobs.map((j) => ({
    id: j.id,
    name: j.name,
    schedule: j.schedule,
    timezone: j.timezone,
    taskType: j.taskType,
    active: j.active,
    lastRun: j.lastRun,
    nextRun: j.nextRun,
    runCount: j.runCount,
  }));
  return JSON.stringify({ status: "ok", action: "list", count: jobs.length, jobs, elapsedMs: Date.now() - start });
}

async function handleDelete(args: any, start: number): Promise<string> {
  const { id } = args;
  if (!id) throw new Error("id is required for delete");
  const store = await loadStore();
  const idx = store.jobs.findIndex((j) => j.id === id);
  if (idx < 0) throw new Error(`Job ${id} not found`);
  const removed = store.jobs.splice(idx, 1)[0];
  await saveStore(store);
  return JSON.stringify({ status: "ok", action: "delete", id, name: removed.name, elapsedMs: Date.now() - start });
}

async function handleToggle(args: any, active: boolean, start: number): Promise<string> {
  const { id } = args;
  const actionName = active ? "resume" : "pause";
  if (!id) throw new Error(`id is required for ${actionName}`);
  const store = await loadStore();
  const job = store.jobs.find((j) => j.id === id);
  if (!job) throw new Error(`Job ${id} not found`);
  job.active = active;
  if (active) {
    job.nextRun = nextOccurrence(job.schedule, new Date(), job.timezone).toISOString();
  }
  await saveStore(store);
  return JSON.stringify({
    status: "ok",
    action: actionName,
    id,
    name: job.name,
    ...(active && { nextRun: job.nextRun }),
    elapsedMs: Date.now() - start,
  });
}

async function handleCheck(start: number): Promise<string> {
  const store = await loadStore();
  const now = new Date();
  const due: Array<{ id: string; name: string; taskType: string; skillName?: string; skillArgs?: any; message?: string }> = [];

  for (const job of store.jobs) {
    if (!job.active) continue;
    if (new Date(job.nextRun).getTime() <= now.getTime()) {
      due.push({
        id: job.id,
        name: job.name,
        taskType: job.taskType,
        ...(job.skillName && { skillName: job.skillName }),
        ...(job.skillArgs && { skillArgs: job.skillArgs }),
        ...(job.message && { message: job.message }),
      });
      job.lastRun = now.toISOString();
      job.runCount++;
      try {
        job.nextRun = nextOccurrence(job.schedule, now, job.timezone).toISOString();
      } catch {
        job.active = false;
      }
    }
  }

  if (due.length > 0) await saveStore(store);

  return JSON.stringify({ status: "ok", action: "check", due, count: due.length, elapsedMs: Date.now() - start });
}

/* ────────────────────── exported for heartbeat integration ────────────────────── */

/**
 * Called by the heartbeat system to check for due cron jobs.
 * Returns an array of due job descriptors for the orchestrator to execute.
 */
export async function checkDueJobs(): Promise<
  Array<{ id: string; name: string; taskType: string; skillName?: string; skillArgs?: any; message?: string }>
> {
  const result = await withLock(() => handleCheck(Date.now()));
  const parsed = JSON.parse(result);
  return parsed.status === "ok" ? parsed.due : [];
}
