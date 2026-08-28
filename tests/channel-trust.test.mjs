// tests/channel-trust.test.mjs — the Channels tab must not be able to flatter itself.
//
// This aggregation replaced a hand-written trust write-up whose numbers were
// typed in once and went stale on the next scan. The failure mode to pin is the
// same one that document had: a channel that reports better than it is. An
// unlisted provider quietly folded into `authoritative`, an aggregator's rows
// counted as if the employer served them, or a posted-date coverage figure that
// counts rows with no date — each one would render as a confident green number.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pass, fail } from './helpers.mjs';
import { buildChannelTrust, providerOf, tierOf, TIER_ORDER } from '../channel-trust.mjs';

console.log('\nchannel-trust — what each ingestion channel can prove');

const ROOT = mkdtempSync(join(tmpdir(), 'career-ops-channels-'));
mkdirSync(join(ROOT, 'data'), { recursive: true });

const HEAD = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company';
const row = (url, seen, portal, company, posted, flags) =>
  [url, seen, portal, 'Engineer', company, 'new', 'Remote', 'fp', posted, '100', flags, company.toLowerCase()].join('\t');

writeFileSync(join(ROOT, 'data/scan-history.tsv'), [
  HEAD,
  row('https://boards.greenhouse.io/acme/jobs/1', '2026-08-01', 'greenhouse-api', 'Acme', '2026-07-30', ''),
  row('https://boards.greenhouse.io/acme/jobs/2', '2026-08-02', 'greenhouse-api', 'Acme', '', ''),
  row('https://jobs.lever.co/beta/3', '2026-08-03', 'lever-api', 'Beta', '2026-08-01', ''),
  row('https://acme.wd1.myworkdayjobs.com/x/job/4', '2026-08-04', 'workday-api', 'Acme', '', ''),
  row('https://builtin.com/job/5', '2026-08-05', 'builtin-api', 'Gamma', '2026-08-04', 'company_domain_mismatch'),
  row('https://builtin.com/job/6', '2026-08-06', 'builtin-api', 'Gamma', '2026-08-05', 'company_domain_mismatch'),
  row('https://example.test/job/7', '2026-08-07', 'brandnew-api', 'Delta', '', ''),
  '',
].join('\n'));

writeFileSync(join(ROOT, 'data/portal-health.tsv'),
  ['timestamp\tcompany\tstatus',
    '2026-08-07\tAcme\treachable',
    '2026-08-07\tBeta\tempty',
    ''].join('\n'));

writeFileSync(join(ROOT, 'portals.yml'), [
  'job_boards:',
  '  - provider: greenhouse',
  '    company: Acme',
  '  - provider: builtin',
  '    aggregator: true',
  '  - provider: lever',
  '    enabled: false',
  '',
].join('\n'));

const t = buildChannelTrust({ root: ROOT });
const by = Object.fromEntries(t.channels.map(c => [c.portal, c]));

// ── tiers are declared, never inferred ───────────────────────────────────────

providerOf('greenhouse-api') === 'greenhouse' && providerOf('local-parser') === 'local-parser'
  ? pass('providerOf strips only the -api suffix scan.mjs adds')
  : fail('providerOf mangled a provider id');

tierOf('brandnew-api') === 'unclassified'
  ? pass('an undeclared provider reports unclassified, not a tier it has not earned')
  : fail('an undeclared provider was folded into a real trust tier');

by['greenhouse-api'].tier === 'authoritative' && by['workday-api'].tier === 'structural' &&
by['builtin-api'].tier === 'indexed'
  ? pass('greenhouse authoritative, workday structural, builtin indexed')
  : fail('a channel landed in the wrong trust tier');

// ── the counts reconcile against the file ────────────────────────────────────

t.total === 7 && t.tiers.reduce((a, x) => a + x.rows, 0) === 7
  ? pass('every history row is counted exactly once across the tiers')
  : fail(`tier rows do not total the history (${t.total} rows, ${t.tiers.reduce((a, x) => a + x.rows, 0)} tiered)`);

by['greenhouse-api'].rows === 2 && by['greenhouse-api'].companies === 1
  ? pass('rows and distinct companies counted per channel')
  : fail('per-channel row or company count is wrong');

// ── posted-date coverage is the honest reliability signal ────────────────────

by['greenhouse-api'].dated === 1 && by['greenhouse-api'].datedPct === 50
  ? pass('an empty posted_at does not count as dated')
  : fail('a row with no posted date was counted as dated — max_posting_age_days looks enforced when it is bypassed');

by['workday-api'].datedPct === 0
  ? pass('a channel that publishes no dates reports 0%, not silence')
  : fail('a dateless channel reported non-zero date coverage');

// ── flags are surfaced, and only the ones actually present ───────────────────

t.flags.length === 1 && t.flags[0].flag === 'company_domain_mismatch' && t.flags[0].n === 2
  ? pass('trust flags are totalled and no flag is invented')
  : fail(`trust flag roll-up is wrong: ${JSON.stringify(t.flags)}`);

by['builtin-api'].flagged === 2 && by['greenhouse-api'].flagged === 0
  ? pass('flags attach to the channel that raised them')
  : fail('trust flags leaked across channels');

// ── aggregator status comes from the config, not from the tier ───────────────

by['builtin-api'].aggregator === true && by['greenhouse-api'].aggregator === false
  ? pass('aggregator reflects the portals.yml claim')
  : fail('aggregator was inferred instead of read from portals.yml');

by['lever-api'].configured === 0
  ? pass('a disabled portals.yml entry is not counted as configured')
  : fail('a disabled board counted toward the configured entries');

// ── liveness rung ────────────────────────────────────────────────────────────

by['greenhouse-api'].rung1 === 2 && by['builtin-api'].rung1 === 0
  ? pass('rung 1 follows the liveness-api predicate, not the tier')
  : fail('rung-1 classification does not match isAtsPosting');

// ── health joins through the companies the channel produced ──────────────────

by['greenhouse-api'].probed === 1 && by['greenhouse-api'].reachable === 1 &&
by['lever-api'].probed === 1 && by['lever-api'].reachable === 0
  ? pass('health joins per company, and a non-reachable status is not counted reachable')
  : fail('portal-health join is wrong');

by['builtin-api'].probed === 0
  ? pass('a channel whose companies were never probed reports no health, not a reassuring zero')
  : fail('an unprobed channel reported health it does not have');

// ── ordering ─────────────────────────────────────────────────────────────────

t.channels.map(c => TIER_ORDER.indexOf(c.tier)).every((v, i, a) => i === 0 || a[i - 1] <= v)
  ? pass('channels sort by tier, most provable first')
  : fail('channel ordering does not lead with the most provable tier');

t.generated === '2026-08-07'
  ? pass('the generated stamp is the newest first_seen in the history')
  : fail(`generated stamp is ${t.generated}`);

// ── an empty root must not throw ─────────────────────────────────────────────

const EMPTY = mkdtempSync(join(tmpdir(), 'career-ops-channels-empty-'));
const e = buildChannelTrust({ root: EMPTY });
e.total === 0 && e.channels.length === 0 && e.tiers.length === 0 && e.generated === null
  ? pass('a root with no scan history yields an empty report rather than an error')
  : fail('an empty root did not produce an empty report');

rmSync(ROOT, { recursive: true, force: true });
rmSync(EMPTY, { recursive: true, force: true });
pass('fixtures cleaned up');
