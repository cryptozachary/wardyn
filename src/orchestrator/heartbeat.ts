import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { Message, SkillMeta } from "../types.js";
import { runAgentLoop } from "./agentLoop.js";

export interface HeartbeatJob {
  name: string;
  cron: string; // simplified: "every <N>m" or "every <N>h"
  prompt: string;
  enabled?: boolean;
}

interface ParsedSchedule {
  intervalMs: number;
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

    console.log(`Heartbeat: scheduling "${job.name}" every ${schedule.intervalMs / 1000}s`);

    const timer = setInterval(async () => {
      const msg: Message = {
        id: `hb-${randomUUID()}`,
        channel: "heartbeat",
        userId: "system",
        text: job.prompt,
        ts: Date.now()
      };

      try {
        const result = await runAgentLoop(msg, skills, getApiKey());
        onResult?.(job, result);
        console.log(`Heartbeat "${job.name}" completed: ${result.final?.slice(0, 100) ?? "(no output)"}`);
      } catch (err: any) {
        console.error(`Heartbeat "${job.name}" failed: ${err.message}`);
      }
    }, schedule.intervalMs);

    timer.unref();
    timers.push(timer);
  }

  // Return a cleanup function
  return () => {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
  };
}
