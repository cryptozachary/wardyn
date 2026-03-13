# cron_skill
Purpose: Schedule recurring tasks using cron expressions. Jobs persist across restarts and can trigger skill calls or return reminder messages. Integrated with the heartbeat system for automatic execution.
Call name: "cron_skill"
Actions:
- create: Schedule a new recurring job. Args: { action: "create", name: "daily backup", schedule: "0 2 * * *", timezone?: "America/New_York", taskType: "skill_call"|"message", skillName?: "...", skillArgs?: {}, message?: "..." }
- list: Show all scheduled jobs with status. Args: { action: "list" }
- delete: Remove a job by ID. Args: { action: "delete", id: "abc123" }
- pause: Temporarily disable a job. Args: { action: "pause", id: "abc123" }
- resume: Re-enable a paused job. Args: { action: "resume", id: "abc123" }
- check: Return all jobs that are due now (called automatically by heartbeat every 60s). Args: { action: "check" }
Schedule formats: Standard 5-field cron (min hour dom month dow) or shorthands: @hourly, @daily, @weekly, @monthly
Timezone: Optional IANA timezone per job (e.g. America/New_York, Europe/London). Defaults to server local time.
Task types: "message" (returns text), "skill_call" (returns skill name + args — validated on create)
Guardrails: Max 50 jobs, 10KB skillArgs limit, 2000 char message limit, 100 char name limit
Parser safety: Strict field validation — rejects step=0, non-numeric tokens, out-of-range values, invalid ranges
Storage: config/cron_jobs.json (atomic writes, concurrency-safe via in-process lock)
Heartbeat integration: Exported checkDueJobs() called by heartbeat every 60s — due skill_call jobs are executed via agentLoop, message jobs are logged.
Returns: JSON with { status, action, elapsedMs, ... }
