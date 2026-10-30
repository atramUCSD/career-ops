// persona-property — 200 generated profiles over one generated corpus. The
// hand-written personas each pin one shape; this checks the invariants that
// must hold for any shape a new user could write into profile.yml. Seeded, so
// a failure names a profile that reproduces: rerun with the seed and index in
// the message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModel, renderHtml } from '../build-artifact.mjs';

const SEED = 20261030;
const PROFILES = 200;
const now = new Date('2026-10-30T15:00:00Z');

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = xs => xs[Math.floor(rand() * xs.length)];
const some = xs => xs.filter(() => rand() < 0.3);
const maybe = (v, p = 0.5) => (rand() < p ? v : undefined);

const ROLES = ['Data Engineer', 'Backend Engineer', 'Frontend Engineer', 'Forward Deployed Engineer',
  'Product Designer', 'Machine Learning Engineer', 'Solutions Architect', 'Site Reliability Engineer'];
const UNMATCHED = ['Account Executive', 'Registered Nurse'];
const CITIES = [
  { loc: 'Chicago, IL', name: 'Illinois', places: 'chicago|evanston', states: ['il'] },
  { loc: 'Austin, TX', name: 'Texas', places: 'austin|round rock', states: ['tx'] },
  { loc: 'New York, NY', name: 'New York', places: 'new york|brooklyn', states: ['ny'] },
  { loc: 'Seattle, WA', name: 'Washington', places: 'seattle|bellevue', states: ['wa'] },
  { loc: 'Denver, CO', name: 'Colorado', places: 'denver|boulder', states: ['co'] },
];
const LOCATIONS = [...CITIES.map(c => c.loc), 'Remote - US', 'Boston, MA'];
const RANK = { primary: 4, secondary: 3, adjacent: 2, lane: 2, unmatched: 1 };

// The corpus: groups of twins. Every row in a group shares company, location,
// posting date and description facts, and differs only in title, so any score
// difference inside a group is the title family's doing.
const FACT_COLUMNS = ['url', 'ok', 'yoe', 'degree', 'clearance', 'sector', 'comp_low', 'comp_high', 'remote', 'hats', 'frameworks', 'fetched', 'location'];
const corpus = [];
const factRows = [];
for (let g = 0; g < 14; g++) {
  const location = pick(LOCATIONS);
  const read = rand() < 0.75;
  const low = maybe(60 + Math.floor(rand() * 190), 0.7);
  const facts = {
    ok: '1',
    yoe: maybe(1 + Math.floor(rand() * 14), 0.8) ?? '',
    degree: pick(['open', 'open', 'master', 'phd']),
    clearance: pick(['none', 'none', 'none', 'secret', 'ts_sci']),
    sector: pick(['none', 'none', 'gov']),
    comp_low: low ? low * 1000 : '',
    comp_high: low ? (low + Math.floor(rand() * 60)) * 1000 : '',
    remote: pick(['', 'remote', 'hybrid', 'onsite']),
    hats: some(['designer', 'developer', 'ai_advocate']).join(','),
    frameworks: some(['foundry']).join(','),
    fetched: '2026-10-29',
    location: '',
  };
  [...ROLES, ...UNMATCHED].forEach((title, i) => {
    const url = `https://x.test/g${g}/r${i}`;
    corpus.push({ g, title, url, line: `- [ ] ${url} | Group${g} Co | ${title} | ${location} | posted: 2026-10-28` });
    if (read) factRows.push(FACT_COLUMNS.map(k => (k === 'url' ? url : facts[k])).join('\t'));
  });
}
const PIPELINE = `# Pipeline\n\n## Pending\n\n${corpus.map(r => r.line).join('\n')}\n\n## Processed\n`;
const FACTS = `${FACT_COLUMNS.join('\t')}\n${factRows.join('\n')}\n`;
const PORTALS = JSON.stringify({ max_posting_age_days: 45, title_filter: { positive: [...ROLES, 'Engineer'], negative: ['Intern'] } });

function generateProfile() {
  const primary = [...new Set([pick(ROLES), ...(rand() < 0.5 ? [pick(ROLES)] : [])])];
  const others = ROLES.filter(r => !primary.includes(r));
  const city = maybe(pick(CITIES), 0.8);
  const archetypes = [
    ...primary.map(name => ({ name, level: pick(['Junior', 'Mid-Senior', 'Senior']), fit: 'primary' })),
    ...some(others).map(name => ({ name, level: 'Mid-Senior', fit: pick(['secondary', 'adjacent']) })),
  ];
  const scoring = Object.fromEntries(Object.entries({
    hats: maybe(true, 0.3),
    degree: maybe(pick(['bachelor', 'master', 'phd'])),
    yoe_ceiling: maybe(2 + Math.floor(rand() * 14)),
    clearance: maybe(pick(['secret', 'ts_sci']), 0.25),
    sector: maybe('gov', 0.2),
    frameworks: maybe(['foundry'], 0.2),
    onsite_within: city && maybe({ name: city.name, places: city.places, states: city.states }, 0.7),
    segments: [
      ...(city ? [{ name: city.name, match: city.places, pool: 1, why: 'home metro' }] : []),
      { name: 'Remote', match: 'remote|anywhere', pool: Number((0.7 + rand() * 0.3).toFixed(2)), why: 'national pool' },
      { name: 'Elsewhere', pool: Number((0.6 + rand() * 0.4).toFixed(2)), why: 'relocation' },
    ],
  }).filter(([, v]) => v !== undefined));
  const profile = {
    candidate: { full_name: 'Generated Persona', location: city?.loc || 'Remote' },
    target_roles: { primary, archetypes },
    ...(rand() < 0.7 ? { compensation: { minimum: `$${60 + Math.floor(rand() * 190)}K`, currency: 'USD' } } : {}),
    scoring,
  };
  const lanes = { lanes: primary.map((r, i) => ({ id: `lane${i}`, archetype: r, title_keywords: [r] })) };
  return { profile, lanes };
}

test(`property: ${PROFILES} generated profiles keep the scoring and page invariants (seed ${SEED})`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-property-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Each invariant counts the cases it actually checked, so a renamed field that
  // turns a check vacuous fails here instead of passing quietly.
  const checked = { gated: 0, hatsOff: 0, ordered: 0, projected: 0 };

  for (let i = 0; i < PROFILES; i++) {
    const { profile, lanes } = generateProfile();
    const root = join(dir, `p${i}`);
    mkdirSync(join(root, 'config'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    // YAML is a superset of JSON, so the generated objects are written as is.
    writeFileSync(join(root, 'config', 'profile.yml'), JSON.stringify(profile));
    writeFileSync(join(root, 'config', 'lanes.yml'), JSON.stringify(lanes));
    writeFileSync(join(root, 'portals.yml'), PORTALS);
    writeFileSync(join(root, 'data', 'pipeline.md'), PIPELINE);
    writeFileSync(join(root, 'data', 'jd-facts.tsv'), FACTS);
    const where = `seed ${SEED}, profile ${i}: ${JSON.stringify(profile)}`;

    const model = buildModel({ root, now });
    const html = renderHtml(model);
    assert.equal(model.rows.length, corpus.length, where);
    for (const r of model.rows) {
      assert.ok(Number.isFinite(r.cb) && r.cb >= 0 && r.cb <= 100, `${r.t} scored ${r.cb}; ${where}`);
      if (!r.gate) continue;
      checked.gated++;
      assert.equal(r.cb, 0, `${r.t} is gated (${r.gate}) but scored ${r.cb}; ${where}`);
    }

    if (!profile.scoring.hats) {
      checked.hatsOff++;
      assert.doesNotMatch(html, /three hats the description demands/, where);
      assert.ok(!model.signals.some(s => s.id === 'hats'), where);
    }
    assert.equal(html.match(/Core targeting \(([^)]*)\)/)?.[1], profile.target_roles.primary.join(' / '), where);
    assert.doesNotMatch(html, /san diego/i, `a maintainer default leaked onto the page; ${where}`);

    // Inside a group of twins, a stronger title family never scores below a weaker one.
    const byUrl = new Map(model.rows.map(r => [r.u, r]));
    for (let g = 0; g < 14; g++) {
      const twins = corpus.filter(c => c.g === g).map(c => byUrl.get(c.url)).filter(r => !r.gate);
      for (const a of twins) for (const b of twins) {
        if (RANK[a.family] > RANK[b.family]) {
          checked.ordered++;
          assert.ok(a.cb >= b.cb, `${a.t} (${a.family}, ${a.cb}) below ${b.t} (${b.family}, ${b.cb}) in group ${g}; ${where}`);
        }
      }
    }

    // As a projection of someone else's scan, the profile keeps every row whose
    // title it targets and drops only the rest.
    const projected = buildModel({ root, profileRoot: root, profileName: `p${i}`, now });
    assert.equal(projected.projection.kept + projected.projection.dropped, corpus.length, where);
    assert.ok(!projected.rows.some(r => r.family === 'unmatched'), where);
    checked.projected += projected.projection.kept;
  }
  for (const [k, n] of Object.entries(checked)) assert.ok(n > 0, `no case exercised the ${k} invariant`);
  t.diagnostic(JSON.stringify(checked));
});
