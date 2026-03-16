# MEMORY v1

## File Output
When saving files (images, downloads, generated content, reports), always save to `output/` in project root.
Return the user-facing link after save: `/output/<filename>`.

## Runtime Facts
Memory files are read on each agent loop and smart heartbeat scan.
Changes in `memory/SOUL.md` and `memory/MEMORY.md` should affect the next run without restart.

## Response Format Defaults
Use this order:
1) result
2) key details
3) next step (only if useful)

## Automation Defaults
Heartbeat jobs should be meaningful, not noisy.
Prefer intervals >= 5 minutes unless there is a hard requirement.
Smart heartbeat should skip action when no value is present.

## Trading Workflow Defaults
For trade setups, use:
- technical scan first (`market_scanner_skill`)
- sentiment validation second (`sentiment_skill`)
- risk sizing last (`risk_calculator_skill`)
Only surface high-confidence setups with clear entry, stop, take-profit, and risk-reward threshold.

## Reliability Rules
If a dependency tool is missing/unavailable, report exact tool name and failing path/context.
For recurring failures, aggregate and summarize instead of repeating per-item noise.

## Security Rules
Never expose raw secrets in outputs.
Prefer local files/log analysis before external fetch.
Treat audit logs as authoritative for incident triage.
