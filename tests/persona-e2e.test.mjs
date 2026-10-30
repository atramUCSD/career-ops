// persona-e2e — the definition of done, checked against a persona that is
// neither maintainer. tests/fixtures/personas/general is a Chicago data and
// backend engineer with no clearance, no hats model, a $140K floor and a 6-year
// ceiling. Each test is one stage of docs/END_TO_END.md; a rule that still reads
// one person's values instead of the profile's fails here first. Offline: no
// network, no model, nothing written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModel, renderHtml } from '../build-artifact.mjs';
import { loadConfig, diffRows } from '../notify-email.mjs';
import { calendarConfig, eventFor, selectRows } from '../calendar-alert.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'personas', 'general');
const now = new Date('2026-10-30T15:00:00Z'); // 10:00 in Chicago
// The fixture has its own config/alerts.yml, so scripts/alert.cmd treats it as a
// separate user layer: its own scan and pipeline, built and mailed with --root.
const model = buildModel({ root, now });
const byCo = Object.fromEntries(model.rows.map(r => [r.c, r]));

test('classify: every row lands in the lane its title keyword names', () => {
  assert.equal(byCo['Acme Data'].lane, 'data');
  assert.equal(byCo['Beta Analytics'].lane, 'backend');
  assert.ok(model.rows.every(r => model.lanes.some(l => l.id === r.lane)));
});

test('project: titles outside the target roles score low here, and are dropped under --as-profile', () => {
  for (const c of ['Zeta Labs', 'Eta AI']) {
    assert.equal(byCo[c].family, 'unmatched');
    assert.ok(byCo[c].cb < loadConfig(root).min_match, `${c} must stay under the mail floor`);
  }
  const projected = buildModel({ root, profileRoot: root, profileName: 'general', now });
  assert.deepEqual(projected.projection, { kept: 8, dropped: 2 });
  assert.ok(!projected.rows.some(r => r.family === 'unmatched'));
});

test('gate: each profile-owned rule stops its row and names itself', () => {
  const gates = Object.fromEntries(model.rows.filter(r => r.gate).map(r => [r.c, r.gate]));
  assert.deepEqual(Object.keys(gates).sort(), ['Delta Freight', 'Epsilon Bank', 'Gamma Systems', 'Kappa Logistics']);
  assert.match(gates['Gamma Systems'], /TS\/SCI/);
  assert.match(gates['Delta Freight'], /outside Illinois/);
  assert.match(gates['Epsilon Bank'], /\$140K walk-away/);
  assert.match(gates['Kappa Logistics'], /6-year ceiling/);
});

test('segment: the home metro is the profile’s, not a default', () => {
  assert.equal(byCo['Kappa Logistics'].seg, 'Chicago', 'Evanston is in the Chicago segment');
  assert.equal(byCo['Beta Analytics'].seg, 'Remote');
  assert.equal(byCo['Delta Freight'].seg, 'Elsewhere', 'the catch-all is the profile’s own');
});

test('rank: a fresh home-metro primary role leads, above-level and remote rank below it', () => {
  const acme = byCo['Acme Data'];
  assert.equal(acme.cbBand, 'premier');
  assert.ok(acme.cb > byCo['Iota Retail'].cb, 'Staff is above the Mid-Senior target');
  assert.ok(acme.cb > byCo['Beta Analytics'].cb, 'Remote carries a wider applicant pool');
});

test('page: nothing on it describes another person’s targeting', () => {
  const html = renderHtml(model);
  assert.doesNotMatch(html, /front-end|forward-deployed|san diego/i);
  assert.match(html, /Core targeting \(Data Engineer \/ Backend Engineer\)/);
  assert.doesNotMatch(html, /three hats the description demands/, 'the hats model is opt-in');
  assert.ok(!model.signals.some(s => s.id === 'hats'));
});

test('mail: the first run reports every ungated row over the floor', () => {
  const cfg = loadConfig(root);
  const { fresh } = diffRows(model.rows, { seen: [], strong: [] }, cfg);
  assert.deepEqual(fresh.map(r => r.c).sort(), ['Acme Data', 'Beta Analytics', 'Iota Retail', 'Theta Health']);
});

test('calendar: the stricter bar, the profile’s own zone, and no LinkedIn', () => {
  const cfg = calendarConfig(loadConfig(root));
  const picks = selectRows(model.rows, cfg);
  assert.deepEqual(picks.map(r => r.c), ['Acme Data'], 'Theta clears the score but is on LinkedIn');
  const e = eventFor(picks[0], cfg, now);
  assert.equal(e.start.dateTime, '2026-10-30T18:30:00');
  assert.equal(e.start.timeZone, 'America/Chicago');
});

test('thresholds: every floor in the persona’s alerts.yml is reachable by its best row', () => {
  // A non-hats profile with no framework, clearance or sector bonus tops out at
  // 62 (title-only fit 0.62 × full timing). A floor above that selects nothing,
  // silently, forever.
  const best = Math.max(...model.rows.map(r => r.cb));
  const cfg = loadConfig(root);
  assert.ok(best >= cfg.min_match, `mail floor ${cfg.min_match} is above the best score ${best}`);
  assert.ok(best >= calendarConfig(cfg).min_match, `calendar floor is above the best score ${best}`);
});
