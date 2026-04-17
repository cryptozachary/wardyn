#!/usr/bin/env tsx
/**
 * Backfill cost_usd for existing llm_usage rows.
 *
 * Walks every row and recomputes cost using the current price table via
 * estimateCost(). Useful after:
 *   - adding new models to the pricing table
 *   - adding snapshot-date stripping (so gpt-5.4-2026-03-05 prices correctly)
 *   - updating rates in config/llm-pricing.json
 *
 * By default only rows where cost_usd IS NULL or 0 are updated. Pass --all to
 * re-price every row (useful after a rate change). Pass --dry to preview.
 *
 *   npm run backfill-llm-cost
 *   npm run backfill-llm-cost -- --all
 *   npm run backfill-llm-cost -- --dry
 */
import { getDb, closeDb } from "../src/db.js";
import { estimateCost } from "../src/llm/usageStore.js";

interface Row {
  id: number;
  model: string | null;
  prompt_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
}

const args = new Set(process.argv.slice(2));
const repriceAll = args.has("--all");
const dryRun = args.has("--dry");

const db = getDb();

const where = repriceAll ? "" : "WHERE cost_usd IS NULL OR cost_usd = 0";
const rows = db.prepare(
  `SELECT id, model, prompt_tokens, output_tokens, cached_tokens, cache_write_tokens, cost_usd
   FROM llm_usage ${where}`
).all() as Row[];

let updated = 0;
let skipped = 0;
let totalDelta = 0;

const update = db.prepare("UPDATE llm_usage SET cost_usd = ? WHERE id = ?");

const tx = db.transaction((batch: Row[]) => {
  for (const r of batch) {
    const cost = estimateCost(
      r.model ?? undefined,
      r.prompt_tokens ?? 0,
      r.output_tokens ?? 0,
      r.cached_tokens ?? 0,
      r.cache_write_tokens ?? 0,
    );
    if (cost == null) { skipped++; continue; }
    const prev = r.cost_usd ?? 0;
    if (Math.abs(cost - prev) < 0.0000001) { skipped++; continue; }
    totalDelta += cost - prev;
    if (!dryRun) update.run(cost, r.id);
    updated++;
  }
});

tx(rows);

const mode = dryRun ? "DRY RUN" : repriceAll ? "RE-PRICED" : "BACKFILLED";
console.log(`[${mode}] scanned ${rows.length} rows · updated ${updated} · skipped ${skipped}`);
if (updated > 0) {
  const sign = totalDelta >= 0 ? "+" : "−";
  console.log(`[${mode}] total cost delta: ${sign}$${Math.abs(totalDelta).toFixed(4)}`);
}
if (skipped > 0 && !repriceAll) {
  console.log(`note: ${skipped} rows had no matching model in the price table — run with --all to re-check after editing config/llm-pricing.json`);
}

closeDb();
