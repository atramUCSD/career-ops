// tests/title-keyword-parity.test.mjs: every reader of a title_filter entry
// must read it the way the scan does.
//
// buildTitleFilter() reads a padded entry ("Java ") as `word:java`. Any other
// consumer that trims the entry first turns it back into a bare substring
// "java", which matches "JavaScript". That drift made doctor report a
// JavaScript positive as vetoed when the scan kept it. In the per-company
// override path and in onboarding the same drift was a real veto. Each
// consumer now goes through titleKeyword(), and these assertions compare each
// one against buildTitleFilter() directly, so a new local trim fails here.

import { readFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { pass, fail, ROOT } from './helpers.mjs';
import { buildTitleFilter, buildTitleFilterOverrides, buildTitleFilterWithOverrides } from '../scan.mjs';
import { titleKeyword } from '../title-keywords.mjs';
import { findTitleFilterConflicts } from '../lib/title-filter-conflicts.mjs';
import { normalizeAnswers, buildPortals } from '../onboard-write.mjs';

console.log('\ntitle_filter keyword parity: doctor, overrides and onboarding read entries as the scan does');

const NEGATIVES = ['Java ', ' Java', 'Java ', 'Java', 'word:Java', 'JÁVA '];
const TITLES = ['Frontend JavaScript Engineer', 'Senior Java Engineer', 'Java Engineer', 'Engineer, Java', 'Senior Java'];

// ── titleKeyword is the scan's own reading ──────────────────────────
if (titleKeyword('Java ') === 'word:java' && titleKeyword('Java ') === 'word:java'
    && titleKeyword('Java') === 'java' && titleKeyword('  ') === '') {
  pass('titleKeyword reads padding (space or NBSP) as word:, a bare entry as a substring');
} else {
  fail(`titleKeyword: ${JSON.stringify(['Java ', 'Java ', 'Java', '  '].map(titleKeyword))}`);
}

// ── doctor's conflict check agrees with the scan ────────────────────
let checkDrift = [];
for (const negative of NEGATIVES) {
  for (const positive of TITLES) {
    const vetoed = !buildTitleFilter({ positive: [positive], negative: [negative] })(positive);
    const reported = findTitleFilterConflicts({ positive: [positive], negative: [negative] }).conflicts.length === 1;
    if (vetoed !== reported) checkDrift.push({ positive, negative, vetoed, reported });
  }
}
if (checkDrift.length === 0) pass('findTitleFilterConflicts reports a conflict exactly when the scan vetoes the title');
else fail(`conflict check disagrees with the scan: ${JSON.stringify(checkDrift)}`);

const reportedCase = findTitleFilterConflicts({ positive: ['JavaScript'], negative: ['Java '] }).conflicts;
const bareCase = findTitleFilterConflicts({ positive: ['JavaScript'], negative: ['Java'] }).conflicts;
if (reportedCase.length === 0 && bareCase.length === 1) {
  pass('padded "Java " does not flag a JavaScript positive; bare "Java" still does');
} else {
  fail(`padded: ${JSON.stringify(reportedCase)}, bare: ${JSON.stringify(bareCase)}`);
}

// ── the per-company override path vetoes what the base filter vetoes ──
const overrides = buildTitleFilterOverrides([{ companies: ['acme'], positive_extra: ['Engineer'] }]);
let overrideDrift = [];
for (const negative of NEGATIVES) {
  const base = buildTitleFilter({ positive: ['Engineer'], negative: [negative] });
  const viaOverride = buildTitleFilterWithOverrides({ positive: ['No Such Title'], negative: [negative] }, overrides);
  for (const title of TITLES) {
    if (base(title) !== viaOverride(title, 'acme')) overrideDrift.push({ negative, title, base: base(title) });
  }
}
if (overrideDrift.length === 0) pass('positive_extra overrides apply negatives exactly as the base filter does');
else fail(`override path disagrees with the base filter: ${JSON.stringify(overrideDrift)}`);

const accented = buildTitleFilterWithOverrides(
  { positive: ['No Such Title'], negative: ['Intern'] },
  buildTitleFilterOverrides([{ companies: ['acme'], positive_extra: ['Ingénieur'] }]),
);
if (accented('Ingenieur Logiciel', 'acme') && !accented('INTERN Ingénieur', 'acme')) {
  pass('the override path folds accents and case on the title, as the base filter does');
} else {
  fail('the override path did not fold the title the way buildTitleFilter does');
}

// ── onboarding keeps padding and drops shipped negatives by the scan's rules ──
const answers = (portals) => ({
  candidate: { full_name: 'Avery Quinn', email: ['avery.quinn', 'example.test'].join('@'), location: 'Denver, CO' },
  target_roles: ['Frontend Engineer'],
  compensation: { target_range: '$95K-120K', currency: 'USD' },
  location: { country: 'United States', timezone: 'America/Denver' },
  portals: { countries: [], cities: [], ...portals },
});

let normalized;
try {
  normalized = normalizeAnswers(answers({ positive: ['Frontend JavaScript Engineer'], negative: ['Java '] }));
  if (normalized.portals.negative[0] === 'Java ') pass('onboarding accepts a padded "Java " negative beside a JavaScript positive and keeps the padding');
  else fail(`onboarding rewrote the negative to ${JSON.stringify(normalized.portals.negative)}`);
} catch (err) {
  fail(`onboarding refused a padded negative the scan accepts: ${err.message}`);
}

const template = readFileSync(join(ROOT, 'templates', 'portals.example.yml'), 'utf8');
const shippedNegatives = yaml.load(template).title_filter.negative;
if (shippedNegatives.includes('Java ')) {
  const written = yaml.load(buildPortals(template, normalizeAnswers(answers({ positive: ['Senior Java'] }))));
  const scan = buildTitleFilter(written.title_filter);
  if (scan('Senior Java')) pass('onboarding drops a shipped padded negative that would veto the user positive "Senior Java"');
  else fail(`written portals.yml vetoes its own positive; negatives: ${JSON.stringify(written.title_filter.negative.filter((n) => /java/i.test(n)))}`);
} else {
  fail('templates/portals.example.yml no longer ships "Java "; repoint this case at a padded shipped negative');
}
