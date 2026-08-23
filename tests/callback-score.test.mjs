// tests/callback-score.test.mjs — the reply-odds prior must stay explainable
// and must not become a keyword counter.
import { pass, fail } from './helpers.mjs';
import { buildScorer, bandOf, SIGNALS } from '../callback-score.mjs';

console.log('\ncallback-score — response-likelihood prior');

const profile = {
  target_roles: {
    archetypes: [
      { name: 'UI/UX Software Engineer', level: 'Mid-Senior', fit: 'primary' },
      { name: 'Developer Relations / Developer Advocate', level: 'Mid-Senior', fit: 'secondary' },
      { name: 'GTM Engineer', level: 'Mid-Senior', fit: 'adjacent' },
    ],
  },
};
const lanes = [
  { id: 'devrel', archetype: 'Developer Relations / Developer Advocate' },
  { id: 'gtm', archetype: 'GTM Engineer' },
];

const row = (o = {}) => ({
  c: 'Acme', t: 'Frontend Engineer', seg: 'San Diego', age: 5,
  lane: 'core', all: ['Frontend'], trust: null, status: 'pending', ...o,
});

function score(r, ctx = {}) {
  return buildScorer({ profile, lanes, rows: [r], history: [], ...ctx })(r);
}

// ── the ask: not one-dimensional keyword maximization ────────────────────────

const noKw = score(row({ all: [] }));
const manyKw = score(row({ all: ['Frontend', 'UI Engineer', 'Web Designer', 'JavaScript'] }));
manyKw.score - noKw.score <= 8
  ? pass('keyword evidence is capped — stuffing positives cannot carry a row')
  : fail(`keywords moved the score by ${manyKw.score - noKw.score}`);

const fresh = score(row({ age: 2 }));
const stale = score(row({ age: 60 }));
fresh.score - stale.score > (manyKw.score - noKw.score)
  ? pass('freshness outweighs keyword evidence')
  : fail('keyword evidence dominates freshness');

// ── geography as an applicant-pool proxy, per the request ────────────────────

score(row({ seg: 'San Diego' })).score > score(row({ seg: 'Remote' })).score
  ? pass('a remote req scores below a local one — national applicant pool')
  : fail('geography is not affecting the pool term');

score(row({ seg: 'OC / LA' })).score > score(row({ seg: 'Other / unknown' })).score
  ? pass('drivable beats out-of-corridor')
  : fail('corridor ordering is wrong');

// ── missing information must not read as a bad posting ───────────────────────

const unknownAge = score(row({ age: null }));
unknownAge.score > stale.score && unknownAge.score < fresh.score
  ? pass('an unpublished date is a mild unknown, not treated as an old posting')
  : fail(`unknown age scored ${unknownAge.score} vs stale ${stale.score}`);

// ── level alignment ──────────────────────────────────────────────────────────

score(row({ t: 'Senior Frontend Engineer' })).score > score(row({ t: 'Frontend Engineer' })).score
  ? pass('a title on the target level scores above an unlevelled one')
  : fail('senior alignment did not register');

score(row({ t: 'Junior Frontend Engineer' })).score < score(row({ t: 'Staff Frontend Engineer' })).score
  ? pass('under-levelled is penalised harder than over-levelled')
  : fail('level penalties are inverted');

// ── family fit comes from profile.yml, not from the lane name ────────────────

score(row({ lane: 'devrel' })).score > score(row({ lane: 'gtm' })).score
  ? pass('a secondary archetype outranks an adjacent one, per config/profile.yml')
  : fail('archetype fit is not being read from the profile');

// ── pipeline-level signals ───────────────────────────────────────────────────

const bulk = Array.from({ length: 20 }, (_, i) => row({ t: `Role ${i}` }));
const focused = score(row(), { rows: [row()] });
const flooded = score(bulk[0], { rows: bulk });
flooded.score < focused.score
  ? pass('a high-volume poster discounts each of its reqs')
  : fail('posting volume had no effect');

const reposted = score(row(), {
  history: [
    { company: 'Acme', title: 'Frontend Engineer', url: 'https://a.test/1' },
    { company: 'Acme', title: 'Frontend Engineer', url: 'https://a.test/2' },
  ],
});
reposted.score < focused.score && reposted.signals.some(s => s.id === 'repost')
  ? pass('a repeatedly reposted company+title takes the evergreen-req discount')
  : fail('repost pattern did not fire');

// ── the column must be able to explain itself ────────────────────────────────

const explained = score(row());
explained.signals.length >= 3 && explained.signals.every(s => s.why && s.delta !== 0)
  ? pass('every contributing signal carries a non-zero delta and a reason')
  : fail(`signals are not explainable: ${JSON.stringify(explained.signals)}`);

explained.signals.every(s => SIGNALS.some(d => d.id === s.id && Math.abs(s.delta) <= d.max))
  ? pass('no signal exceeds its declared cap')
  : fail('a signal moved the score further than its declared cap');

// ── bounds ───────────────────────────────────────────────────────────────────

const worst = score(row({ t: 'Junior Engineer', seg: 'Remote', age: 400, all: [], lane: 'gtm', trust: 0 }));
const best = score(row({ t: 'Senior Frontend Engineer', seg: 'San Diego', age: 1, all: ['Design Technologist', 'Frontend'], trust: 100 }));
worst.score >= 0 && best.score <= 100 && worst.score < best.score
  ? pass('scores stay inside 0-100 and order correctly at the extremes')
  : fail(`bounds broken: ${worst.score} / ${best.score}`);

bandOf(90) === 'strong' && bandOf(60) === 'likely' && bandOf(50) === 'even' && bandOf(10) === 'low'
  ? pass('bands map as documented')
  : fail('band thresholds are wrong');
