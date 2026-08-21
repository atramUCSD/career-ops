#!/usr/bin/env node
/**
 * prune-pipeline.mjs — keep data/pipeline.md to postings you can actually apply to.
 *
 * THE PROBLEM
 * A posting can die after it reaches the pipeline. Nothing walked back and
 * removed it, so a dead role sat in "Pending" forever and got picked up by the
 * next `/career-ops pipeline` run — a full evaluation, a report, sometimes a
 * PDF, all for a job that closed months ago. The same is true of postings that
 * are still technically live but were posted two years ago: they are open in
 * the ATS and closed in practice, and an application against one is unlikely to
 * reach a recruiter.
 *
 * WHAT THIS DOES
 * Two independent prunes, both moving entries from "Pending" to "Processed"
 * with the reason written on the line:
 *
 *   - EXPIRED (always): every URL recorded in data/expired-jobs.md. That file is
 *     the memory — whichever path confirmed the death (a scan, a standalone
 *     check-liveness run) wrote it there, and this consumes it. Nothing here
 *     re-checks liveness; a URL is dead because the log says it was confirmed
 *     dead, which keeps this script offline and instant.
 *   - STALE (--stale <days>, opt-in): entries whose `posted:` date is older than
 *     N days. This is a judgement call about response odds, not a fact about the
 *     posting, so it never runs unless you ask for it and name the threshold.
 *
 * The moved line keeps its URL in the plain `- [x] {url}` form rather than the
 * struck-through `~~{url}~~` the mode docs once suggested, because scan.mjs's
 * dedup reads `- [\[ x]\] (https?://\S+)` — a strikethrough would hide the URL
 * from that regex and let the next scan re-add the posting as a fresh find.
 *
 * Run: node prune-pipeline.mjs [--dry-run] [--stale <days>]
 *   CAREER_OPS_PIPELINE overrides the pipeline path (same env var scan.mjs uses).
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { parseExpiredLog, EXPIRED_LOG_PATH } from './expired-log.mjs';
import { normalizeUrlForDedup } from './scan.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { pathToFileURL } from 'url';

const PIPELINE_PATH = process.env.CAREER_OPS_PIPELINE || 'data/pipeline.md';

const PENDING_RE = /^##\s+(Pendientes|Pending)\s*$/i;
const PROCESSED_RE = /^##\s+(Procesadas|Processed)\s*$/i;
const PENDING_ITEM_RE = /^-\s\[ \]\s+(https?:\/\/\S+)(.*)$/;

/** Days between two YYYY-MM-DD dates, or null if the posted date is unusable. */
function ageInDays(postedIso, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(postedIso || '')) return null;
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${postedIso}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
}

/**
 * Decide what to prune and render the new pipeline text. Pure — no I/O — so the
 * decision can be tested and previewed (--dry-run prints the plan without ever
 * touching the file).
 *
 * @param {string} text - current pipeline.md
 * @param {Map<string, any>} dead - rows from parseExpiredLog, keyed by URL
 * @param {{staleDays?: number|null, today: string}} opts
 * @returns {{text: string, moved: Array<{url: string, reason: string, kind: 'expired'|'stale'}>, pending: number}}
 */
export function planPrune(text, dead, { staleDays = null, today }) {
  const deadByNormalized = new Map();
  for (const [url, row] of dead) deadByNormalized.set(normalizeUrlForDedup(url), row);

  const lines = text.split('\n');
  const pendStart = lines.findIndex((l) => PENDING_RE.test(l.trim()));
  if (pendStart === -1) return { text, moved: [], pending: 0 };

  // Every unchecked entry below the Pending header counts, not just the ones in
  // that first section: scan runs append their own `## Targeted-company run —
  // <date>` sections of `- [ ]` lines, and those are pending work too. Only a
  // Processed section is skipped — its entries are already resolved.
  const kept = [];
  const movedLines = [];
  const moved = [];
  let pending = 0;
  let inProcessed = false;
  let procIdx = -1;

  for (let i = pendStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      inProcessed = PROCESSED_RE.test(line.trim());
      if (inProcessed && procIdx === -1) procIdx = kept.length;
      kept.push(line);
      continue;
    }
    const m = inProcessed ? null : line.match(PENDING_ITEM_RE);
    if (!m) { kept.push(line); continue; }
    pending++;
    const [, url, rest] = m;
    const row = deadByNormalized.get(normalizeUrlForDedup(url));
    if (row) {
      const evidence = row.evidence ? `, ${row.evidence}` : '';
      const reason = `expired (confirmed ${row.removed}${evidence})`;
      movedLines.push(`- [x] ${url}${rest} — ${reason}`);
      moved.push({ url, reason, kind: 'expired' });
      continue;
    }
    if (staleDays) {
      const posted = (rest.match(/posted:\s*(\d{4}-\d{2}-\d{2})/) || [])[1];
      const age = ageInDays(posted, today);
      if (age !== null && age > staleDays) {
        const reason = `stale (posted ${posted}, ${age} days old > ${staleDays})`;
        movedLines.push(`- [x] ${url}${rest} — ${reason}`);
        moved.push({ url, reason, kind: 'stale' });
        continue;
      }
    }
    kept.push(line);
  }

  if (moved.length === 0) return { text, moved: [], pending };

  const head = lines.slice(0, pendStart + 1);
  if (procIdx === -1) {
    // No Processed section yet — create one, matching the language of the
    // Pending header we found so a Spanish file stays Spanish.
    const header = /Pending/i.test(lines[pendStart]) ? '## Processed' : '## Procesadas';
    return {
      text: [...head, ...kept, '', header, '', ...movedLines].join('\n'),
      moved,
      pending: pending - moved.length,
    };
  }
  const body = [...kept.slice(0, procIdx + 1), ...movedLines, ...kept.slice(procIdx + 1)];
  return { text: [...head, ...body].join('\n'), moved, pending: pending - moved.length };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log('Usage: node prune-pipeline.mjs [--dry-run] [--stale <days>]');
    console.log('  Moves confirmed-expired (and optionally stale) pending entries to "Processed".');
    process.exit(0);
  }
  const dryRun = args.includes('--dry-run');
  const staleIdx = args.indexOf('--stale');
  const staleDays = staleIdx >= 0 ? Number(args[staleIdx + 1]) : null;
  if (staleIdx >= 0 && (!Number.isFinite(staleDays) || staleDays <= 0)) {
    console.error(`--stale expects a positive number of days, got "${args[staleIdx + 1] ?? '(no value)'}"`);
    process.exit(1);
  }

  if (!existsSync(PIPELINE_PATH)) {
    console.error(`No pipeline at ${PIPELINE_PATH}`);
    process.exit(1);
  }
  const dead = existsSync(EXPIRED_LOG_PATH) ? parseExpiredLog(readFileSync(EXPIRED_LOG_PATH, 'utf-8')) : new Map();
  const today = new Date().toISOString().slice(0, 10);

  const run = () => {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    const plan = planPrune(text, dead, { staleDays, today });
    if (!dryRun && plan.moved.length > 0) writeFileSync(PIPELINE_PATH, plan.text, 'utf-8');
    return plan;
  };
  const plan = dryRun ? run() : await withPipelineLock(PIPELINE_PATH, async () => run());

  const expiredCount = plan.moved.filter((m) => m.kind === 'expired').length;
  const staleCount = plan.moved.filter((m) => m.kind === 'stale').length;
  for (const m of plan.moved) console.log(`  ${m.kind === 'expired' ? '❌' : '🕸️'} ${m.url} — ${m.reason}`);
  console.log(
    `\n${dryRun ? 'Would move' : 'Moved'} ${plan.moved.length} entr${plan.moved.length === 1 ? 'y' : 'ies'} ` +
    `(${expiredCount} expired, ${staleCount} stale). Pending now: ${plan.pending}.`
  );
  if (dryRun && plan.moved.length > 0) console.log('Dry run — pipeline.md unchanged. Re-run without --dry-run to apply.');
}

// Import-safe: only run the CLI when invoked directly, so tests can import planPrune.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
