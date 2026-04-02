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

## Operator Alignment (Product Strategist)
Favor ideas related to:
- AI tools and agents
- music production / audio processing
- automation and workflows
- dashboards / analytics
- developer tools
- creative tools
- viral/simple consumer apps

Avoid ideas requiring:
- complex enterprise systems
- long build cycles (>3 days)
- heavy infrastructure or large teams
- deep domain expertise the operator lacks

## Idea Log
Past ideas, scores, and outcomes are tracked in memory/idea_log.json.
Check before generating to avoid repeats or saturated concepts without a twist.
Update status when an idea is built, rejected, or shelved.

## Signal Sources (Product Strategist)
When scanning for signals, use browser_skill to check these concrete sources:
- https://news.ycombinator.com (HackerNews front page — trending tools, complaints, Show HN posts)
- https://www.producthunt.com (new launches — spot gaps, overserved categories, interesting UX)
- https://www.indiehackers.com (solo builder wins — what's actually making money)
- https://x.com/search?q=annoying+app OR "i+wish+there+was" (raw user pain signals)
- https://www.reddit.com/r/SideProject/ (what solo devs are shipping)
- https://www.reddit.com/r/InternetIsBeautiful/ (viral simple tools — pattern recognition)
- https://trends.google.com/trending (breakout search trends)
- https://github.com/trending (what developers are building this week)

Don't hit all sources every cycle. Pick 2-3 based on the active strategist mode.
Viral_hunter → X, Reddit, trending. Money_maker → IndieHackers, ProductHunt. Creator_tools → HackerNews, GitHub. Leverage_builder → GitHub, HackerNews.

## Signal Bank
Raw signals that don't produce a winning idea this cycle go to memory/signal_bank.json.
Check signal_bank.json at the start of each cycle — a stale signal + new context can become a winner.
