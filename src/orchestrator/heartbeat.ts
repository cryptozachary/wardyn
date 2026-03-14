import { readFileSync, existsSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { randomUUID } from "crypto";
import { Message, SkillMeta } from "../types.js";
import { runAgentLoop } from "./agentLoop.js";
import { callLLM } from "../llm/router.js";
import { scanContext, formatSnapshot } from "./contextScanner.js";

/* ────────── cron_skill integration ────────── */

let checkDueJobsFn: (() => Promise<any[]>) | null = null;

async function loadCronChecker(): Promise<void> {
  if (checkDueJobsFn) return;
  try {
    const cronSkillPath = path.join(process.cwd(), "dist", "skills", "cron_skill", "index.js");
    const srcPath = path.join(process.cwd(), "skills", "cron_skill", "index.js");
    const target = existsSync(cronSkillPath) ? cronSkillPath : existsSync(srcPath) ? srcPath : null;
    if (!target) return;
    // Use file:// URL for cross-platform ESM dynamic import compatibility
    const mod = await import(pathToFileURL(target).href);
    if (mod?.checkDueJobs) checkDueJobsFn = mod.checkDueJobs;
  } catch (err) {
    console.warn(`Failed to load cron_skill: ${(err as Error).message}`);
  }
}

export interface HeartbeatJob {
  name: string;
  cron: string; // simplified: "every <N>m" or "every <N>h" or "every <N>s"
  prompt: string; // for fixed mode: the prompt to send; for smart mode: the goal/role description
  enabled?: boolean;
  mode?: "fixed" | "smart"; // default: "fixed"
  scanWindowMs?: number; // how far back to look for smart mode (default: 2 hours)
}

interface ParsedSchedule {
  intervalMs: number;
}

interface TriageResult {
  act: boolean;
  reason: string;
  prompt: string | null;
}

function parseCron(cron: string): ParsedSchedule {
  const match = cron.match(/^every\s+(\d+)\s*(m|h|s)$/i);
  if (!match) throw new Error(`Invalid cron format "${cron}". Use "every <N>m", "every <N>h", or "every <N>s".`);
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };
  return { intervalMs: value * multipliers[unit] };
}

export function loadHeartbeatConfig(): HeartbeatJob[] {
  const configPath = path.join(process.cwd(), "config", "heartbeat.json");
  if (!existsSync(configPath)) return [];
  try {
    const raw = readFileSync(configPath, "utf8");
    const jobs: HeartbeatJob[] = JSON.parse(raw);
    return jobs.filter(j => j.enabled !== false);
  } catch {
    console.warn("Failed to parse heartbeat.json, skipping heartbeat jobs.");
    return [];
  }
}

const TRIAGE_SYSTEM_PROMPT = `You are a proactive AI agent's heartbeat triage system. Your job is to look at a snapshot of recent activity and decide whether the agent should take action.

You will receive:
1. A context snapshot showing recent sessions, errors, tool usage, and logs
2. The agent's goal/role description

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "act": true or false,
  "reason": "brief explanation of why you decided to act or not",
  "prompt": "if act is true, the specific prompt the agent should execute. if false, null"
}

Guidelines for deciding to act:
- ACT if there are unresolved errors that could be investigated or fixed
- ACT if a user asked a question that wasn't fully answered
- ACT if there's a pattern of repeated failures worth addressing
- ACT if the agent's goal requires periodic proactive work (monitoring, summarizing, etc.)
- DO NOT ACT if everything looks normal and there's nothing meaningful to do
- DO NOT ACT if the only activity is the heartbeat's own previous runs
- Prefer doing nothing over generating noise — only act when there's genuine value`;

/**
 * Run the triage phase: scan context and ask the LLM if action is needed.
 */
async function triageSmartJob(job: HeartbeatJob, apiKey: string): Promise<TriageResult> {
  const windowMs = job.scanWindowMs ?? 2 * 3_600_000;
  const snapshot = scanContext(windowMs);
  const contextStr = formatSnapshot(snapshot);

  const messages = [
    { role: "system" as const, content: TRIAGE_SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: `## Agent Goal\n${job.prompt}\n\n## Context Snapshot\n${contextStr}`
    }
  ];

  const result = await callLLM({ messages }, apiKey);

  if (!result.text) {
    return { act: false, reason: "Triage returned no response", prompt: null };
  }

  try {
    // Strip markdown code fences if present
    const cleaned = result.text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      act: !!parsed.act,
      reason: parsed.reason || "No reason given",
      prompt: parsed.prompt || null
    };
  } catch {
    // If the LLM didn't return valid JSON, treat the whole response as a prompt
    console.warn(`Heartbeat "${job.name}": triage returned non-JSON, treating as action prompt`);
    return {
      act: true,
      reason: "Triage returned free-text response",
      prompt: result.text
    };
  }
}

export function startHeartbeat(
  jobs: HeartbeatJob[],
  skills: SkillMeta[],
  getApiKey: () => string,
  onResult?: (job: HeartbeatJob, result: any) => void
): (() => void) {
  const timers: NodeJS.Timeout[] = [];

  for (const job of jobs) {
    let schedule: ParsedSchedule;
    try {
      schedule = parseCron(job.cron);
    } catch (err: any) {
      console.error(`Heartbeat job "${job.name}": ${err.message}`);
      continue;
    }

    const mode = job.mode || "fixed";
    console.log(`Heartbeat: scheduling "${job.name}" (${mode}) every ${schedule.intervalMs / 1000}s`);

    const timer = setInterval(async () => {
      try {
        if (mode === "smart") {
          await executeSmartJob(job, skills, getApiKey, onResult);
        } else {
          await executeFixedJob(job, skills, getApiKey, onResult);
        }
      } catch (err: any) {
        console.error(`Heartbeat "${job.name}" failed: ${err.message}`);
      }
    }, schedule.intervalMs);

    timer.unref();
    timers.push(timer);
  }

  // Fix #2: Wire cron_skill into heartbeat — check every 60s for due cron jobs
  const cronTimer = setInterval(async () => {
    try {
      await loadCronChecker();
      if (!checkDueJobsFn) return;

      const dueJobs = await checkDueJobsFn();
      for (const dueJob of dueJobs) {
        if (dueJob.taskType === "skill_call" && dueJob.skillName) {
          const prompt = `Run the ${dueJob.skillName} skill with these arguments: ${JSON.stringify(dueJob.skillArgs ?? {})}`;
          const msg: Message = {
            id: `cron-${randomUUID()}`,
            channel: "heartbeat",
            userId: "system",
            text: prompt,
            ts: Date.now(),
          };
          const result = await runAgentLoop(msg, skills, getApiKey());
          console.log(`Cron "${dueJob.name}" (skill_call): ${result.final ?? "(no output)"}`);
        } else if (dueJob.taskType === "message" && dueJob.message) {
          console.log(`Cron "${dueJob.name}" (message): ${dueJob.message}`);
          onResult?.({ name: dueJob.name, cron: "cron_skill", prompt: dueJob.message }, { final: dueJob.message });
        }
      }
    } catch (err: any) {
      console.error(`Cron check failed: ${err.message}`);
    }
  }, 60_000);
  cronTimer.unref();
  timers.push(cronTimer);

  return () => {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
  };
}

async function executeFixedJob(
  job: HeartbeatJob,
  skills: SkillMeta[],
  getApiKey: () => string,
  onResult?: (job: HeartbeatJob, result: any) => void
) {
  const msg: Message = {
    id: `hb-${randomUUID()}`,
    channel: "heartbeat",
    userId: "system",
    text: job.prompt,
    ts: Date.now()
  };

  const result = await runAgentLoop(msg, skills, getApiKey());
  onResult?.(job, result);
  console.log(`Heartbeat "${job.name}" completed: ${result.final ?? "(no output)"}`);
}

async function executeSmartJob(
  job: HeartbeatJob,
  skills: SkillMeta[],
  getApiKey: () => string,
  onResult?: (job: HeartbeatJob, result: any) => void
) {
  // Phase 1: Triage
  console.log(`Heartbeat "${job.name}": scanning context...`);
  const triage = await triageSmartJob(job, getApiKey());
  console.log(`Heartbeat "${job.name}" triage: act=${triage.act}, reason="${triage.reason}"`);

  if (!triage.act || !triage.prompt) {
    onResult?.(job, { final: null, skipped: true, reason: triage.reason });
    return;
  }

  // Phase 2: Execute the triage-generated prompt
  const msg: Message = {
    id: `hb-${randomUUID()}`,
    channel: "heartbeat",
    userId: "system",
    text: triage.prompt,
    ts: Date.now()
  };

  const result = await runAgentLoop(msg, skills, getApiKey(), {
    sessionId: `heartbeat-${job.name}`
  });
  onResult?.(job, { ...result, triageReason: triage.reason });
  console.log(`Heartbeat "${job.name}" acted: ${result.final ?? "(no output)"}`);
}
