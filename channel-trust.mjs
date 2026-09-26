// @ts-check
// channel-trust.mjs — how much each ingestion channel can be believed.
//
// The pipeline treats every row the same once it is in data/pipeline.md, but the
// channels that produced those rows are not equally reliable, and the difference
// is not a matter of opinion — it is a property of what each channel publishes
// and of what its API says when a posting goes away.
//
// This module folds the evidence already on disk into one row per channel:
//
//   data/scan-history.tsv   volume, distinct companies, posted-date coverage,
//                           trust flags, and (via liveness-api) which rung can
//                           confirm a posting is gone
//   data/portal-health.tsv  whether the sources behind that channel answered at
//                           the last probe
//   portals.yml             which channels are declared aggregators
//
// Nothing here is typed in by hand. The previous version of this analysis was a
// written document with the numbers pasted into it, which was accurate for
// exactly as long as it took the next scan to run.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { isAtsPosting } from './liveness-api.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Trust tiers, keyed by provider id (the scan-history `portal` column is
 * `${provider.id}-api`).
 *
 * The tiers are not a ranking of how nice the board is. They record what the
 * channel's own API can prove:
 *
 *   authoritative — the employer's ATS serves a public per-job endpoint, and a
 *                   404 there is proof the posting is gone. Liveness resolves at
 *                   rung 1 with a definitive answer.
 *   structural    — the employer's ATS, reached through a tenant indirection
 *                   whose error codes are ambiguous (Workday answers 403 for an
 *                   unpublished posting, iCIMS returns the same status for "gone"
 *                   and "wrong board"). Reachable, but a removal needs
 *                   corroboration before it is believed.
 *   indexed       — the record is a copy of someone else's posting. It can be
 *                   stale in both directions: still listed after the employer
 *                   pulled it, or absent while the employer is still hiring.
 *                   company_domain_mismatch is raised here by construction.
 *
 * One line per provider. Adding a provider means adding it here; an unlisted one
 * reports `unclassified` rather than being silently folded into a tier it has
 * not earned.
 */
export const TIERS = {
  greenhouse: 'authoritative',
  ashby: 'authoritative',
  lever: 'authoritative',
  smartrecruiters: 'authoritative',
  consider: 'authoritative',
  'local-parser': 'authoritative',

  workday: 'structural',
  icims: 'structural',
  eightfold: 'structural',
  'eightfold-pcsx': 'structural',
  rippling: 'structural',

  builtin: 'indexed',
  linkedin: 'indexed',
  'a16z-speedrun-talent': 'indexed',
  'agentic-jobs': 'indexed',
  themuse: 'indexed',
  jobicy: 'indexed',
  remoteok: 'indexed',
  weworkremotely: 'indexed',
  himalayas: 'indexed',
  remotive: 'indexed',
  nodesk: 'indexed',
  workingnomads: 'indexed',
  '4dayweek': 'indexed',
};

export const TIER_ORDER = ['authoritative', 'structural', 'indexed', 'unclassified'];

export const TIER_NOTES = {
  authoritative: 'Employer ATS with a public per-job API. A 404 there is proof the posting is gone.',
  structural: 'Employer ATS behind a tenant indirection. Reachable, but its error codes are ambiguous, so a removal needs corroboration.',
  indexed: 'A copy of someone else’s posting. Can be stale in either direction, and raises company_domain_mismatch by construction.',
  unclassified: 'No tier declared for this provider in channel-trust.mjs.',
};

/** `greenhouse-api` -> `greenhouse`. The suffix is scan.mjs's, not the provider's. */
export function providerOf(portal) {
  return String(portal || '').replace(/-api$/, '');
}

export function tierOf(portal) {
  return TIERS[providerOf(portal)] || 'unclassified';
}

/** Split a TSV into objects keyed by its header row. Empty/absent file is []. */
function readTsv(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const head = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const row = {};
    head.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

/**
 * Which providers portals.yml declares as aggregators, and how many enabled
 * entries each one has. Read from the config rather than inferred from the tier:
 * `aggregator: true` is a claim the operator made, and a channel whose tier says
 * indexed while the config never marked it is worth seeing as a mismatch.
 */
function aggregatorsFrom(portals) {
  const out = new Map();
  for (const entry of portals.job_boards || []) {
    if (entry?.enabled === false) continue;
    const id = entry.provider || '';
    if (!id) continue;
    const cur = out.get(id) || { entries: 0, aggregator: false };
    cur.entries++;
    if (entry.aggregator === true) cur.aggregator = true;
    out.set(id, cur);
  }
  return out;
}

/** Latest health status per company name. Later rows win; the file is append-only. */
function healthByCompany(rows) {
  const out = new Map();
  for (const r of rows) if (r.company) out.set(r.company, r.status || 'unknown');
  return out;
}

/**
 * One row per ingestion channel.
 *
 * @param {{root?: string}} [opts]
 * @returns {{
 *   channels: Array<object>, tiers: Array<object>, flags: Array<{flag: string, n: number}>,
 *   total: number, dated: number, rung1: number, generated: string|null,
 * }}
 */
export function buildChannelTrust({ root = ROOT } = {}) {
  const history = readTsv(join(root, 'data/scan-history.tsv'));
  const health = healthByCompany(readTsv(join(root, 'data/portal-health.tsv')));
  const portals = existsSync(join(root, 'portals.yml'))
    ? yaml.load(readFileSync(join(root, 'portals.yml'), 'utf-8')) || {}
    : {};
  const declared = aggregatorsFrom(portals);

  const byPortal = new Map();
  const flags = new Map();
  let dated = 0;
  let rung1 = 0;
  let latest = null;

  for (const row of history) {
    const portal = row.portal || '(none)';
    let c = byPortal.get(portal);
    if (!c) {
      c = {
        portal,
        provider: providerOf(portal),
        tier: tierOf(portal),
        rows: 0,
        companies: new Set(),
        // The health file records the board/company under its portals.yml
        // display name, so the join needs the raw column, not the normalized one.
        sources: new Set(),
        dated: 0,
        rung1: 0,
        flags: new Map(),
        firstSeen: null,
        lastSeen: null,
        health: { reachable: 0, other: 0 },
      };
      byPortal.set(portal, c);
    }
    c.rows++;
    const company = row.normalized_company || row.company || '';
    if (company) c.companies.add(company);
    if (row.company) c.sources.add(row.company);
    if (row.posted_at) { c.dated++; dated++; }
    // The rung-1 test is the same predicate check-liveness uses, asked of the URL
    // itself. Reimplementing it as a host list here would drift the moment a
    // resolver is added.
    if (row.url && isAtsPosting(row.url)) { c.rung1++; rung1++; }
    for (const f of String(row.trust_flags || '').split(/[,;|]/).map(s => s.trim()).filter(Boolean)) {
      c.flags.set(f, (c.flags.get(f) || 0) + 1);
      flags.set(f, (flags.get(f) || 0) + 1);
    }
    const seen = row.first_seen || '';
    if (seen) {
      if (!c.firstSeen || seen < c.firstSeen) c.firstSeen = seen;
      if (!c.lastSeen || seen > c.lastSeen) c.lastSeen = seen;
      if (!latest || seen > latest) latest = seen;
    }
  }

  // Health is recorded per company, not per channel, so it joins through the
  // companies each channel actually produced. A channel whose companies were
  // never probed reports no health rather than a reassuring zero.
  for (const c of byPortal.values()) {
    for (const company of c.sources) {
      const status = health.get(company);
      if (status === undefined) continue;
      if (status === 'reachable') c.health.reachable++;
      else c.health.other++;
    }
  }

  const channels = [...byPortal.values()].map((c) => {
    const d = declared.get(c.provider);
    const probed = c.health.reachable + c.health.other;
    return {
      portal: c.portal,
      provider: c.provider,
      tier: c.tier,
      rows: c.rows,
      companies: c.companies.size,
      dated: c.dated,
      // The honest reliability number. A channel that publishes no posted date
      // bypasses max_posting_age_days entirely: nothing it contributes can be
      // aged out, so its rows accumulate whatever their real age.
      datedPct: c.rows ? Math.round((c.dated / c.rows) * 100) : 0,
      rung1: c.rung1,
      rung1Pct: c.rows ? Math.round((c.rung1 / c.rows) * 100) : 0,
      flags: [...c.flags].map(([flag, n]) => ({ flag, n })).sort((a, b) => b.n - a.n),
      flagged: [...c.flags.values()].reduce((a, b) => a + b, 0),
      aggregator: d ? d.aggregator : false,
      configured: d ? d.entries : 0,
      probed,
      reachable: c.health.reachable,
      firstSeen: c.firstSeen,
      lastSeen: c.lastSeen,
    };
  }).sort((a, b) =>
    TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || b.rows - a.rows);

  const tiers = TIER_ORDER.map((tier) => {
    const members = channels.filter(c => c.tier === tier);
    const rows = members.reduce((a, c) => a + c.rows, 0);
    return {
      tier,
      note: TIER_NOTES[tier],
      channels: members.length,
      rows,
      pct: history.length ? Math.round((rows / history.length) * 100) : 0,
      dated: members.reduce((a, c) => a + c.dated, 0),
      flagged: members.reduce((a, c) => a + c.flagged, 0),
    };
  }).filter(t => t.channels > 0);

  return {
    channels,
    tiers,
    flags: [...flags].map(([flag, n]) => ({ flag, n })).sort((a, b) => b.n - a.n),
    total: history.length,
    dated,
    rung1,
    generated: latest,
  };
}
