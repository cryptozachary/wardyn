# reminder_skill
Purpose: Set, list, and manage time-based reminders. Reminders persist to disk and can be checked by heartbeat for proactive notifications.
Call name: "reminder_skill"
Actions:
- set: Create a reminder. Args: { action: "set", message: "Check deployment", dueIn: "30m" }. Durations: 30m, 2h, 1d, 3h30m, etc.
- list: Show active reminders. Args: { action: "list" }
- delete: Remove a reminder. Args: { action: "delete", id: "abc123" }
- check: Return all due (unfired) reminders and mark them fired. Args: { action: "check" }. Use this in heartbeat jobs.
Returns: Structured JSON with status, action, and reminder data.
