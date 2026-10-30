// persona-run — the general persona over time, on a temp copy of
// tests/fixtures/personas/general. persona-e2e checks one snapshot; this checks
// the two things a snapshot cannot: that the facts the scorer reads come out of
// the real parser run over real description text, and that the mail stays
// correct from one scheduled run to the next. Offline: --reparse reads only the
// fixture's data/jd-cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModel } from '../build-artifact.mjs';
import { composeRun, diffRows, loadConfig, loadState, saveState } from '../notify-email.mjs';
import { calendarConfig, eventFor } from '../calendar-alert.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const fixture = join(repo, 'tests', 'fixtures', 'personas', 'general');

function copyFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'persona-run-'));
  cpSync(fixture, root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const readTsv = file => {
  const [head, ...lines] = readFileSync(file, 'utf-8').trimEnd().split('\n');
  const cols = head.split('\t');
  return new Map(lines.map(l => {
    const row = Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v]));
    return [row.url, row];
  }));
};

test('read: the committed facts are what enrich-jd extracts from the cached descriptions', t => {
  const root = copyFixture(t);
  rmSync(join(root, 'data', 'jd-facts.tsv'));
  const env = { ...process.env, CAREER_OPS_ROOT: root };
  delete env.CAREER_OPS_DATA_DIR;
  const r = spawnSync(process.execPath, ['enrich-jd.mjs', '--reparse', '--skip', 'linkedin.com'], { cwd: repo, env, encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);

  const got = readTsv(join(root, 'data', 'jd-facts.tsv'));
  const want = readTsv(join(fixture, 'data', 'jd-facts.tsv'));
  for (const [url, row] of want) {
    assert.deepEqual({ ...got.get(url), fetched: '' }, { ...row, fetched: '' }, url);
  }
  // The edge cases the texts carry, spelled out so a parser change that moves
  // them reads as a finding rather than a golden-file diff.
  const acme = got.get('https://boards.greenhouse.io/acmedata/jobs/1');
  assert.deepEqual([acme.comp_low, acme.comp_high], ['145000', '175000'], '"$145,000 – $175,000"');
  assert.equal(acme.degree, 'open', 'a bachelor requirement is not a gate, so the parser files it as open');
  const delta = got.get('https://x.test/delta/4');
  assert.deepEqual([delta.comp_low, delta.comp_high], ['150000', '180000'], 'the "$85/hour" contract rate is not annual comp');
  assert.equal(got.get('https://x.test/epsilon/5').yoe, '3', '"3-5 years" floors at 3');

  // A row with no cached text is recorded unread, and the skipped host not at all.
  assert.equal(got.get('https://jobs.lever.co/beta/2').ok, '0');
  assert.ok(!got.has('https://www.linkedin.com/jobs/view/8'), '--skip linkedin.com');
});

test('days: each scheduled run mails only what changed since the last one', t => {
  const root = copyFixture(t);
  const cfg = loadConfig(root);
  const run = now => {
    const model = buildModel({ root, now });
    const diff = diffRows(model.rows, loadState(root), cfg);
    const out = composeRun({ root, now, model });
    saveState(out.nextState, root);
    const names = rows => rows.map(r => r.c).sort();
    return { model, quiet: out.quiet, fresh: names(diff.fresh), upgraded: names(diff.upgraded) };
  };

  const day0 = run(new Date('2026-10-30T15:00:00Z'));
  assert.deepEqual(day0.fresh, ['Acme Data', 'Beta Analytics', 'Iota Retail', 'Theta Health']);
  assert.deepEqual(day0.upgraded, []);

  // Three days later: one new posting, one taken down, and Kappa's posting
  // edited from 10+ years to 4, which clears the persona's 6-year ceiling.
  const pipeline = join(root, 'data', 'pipeline.md');
  writeFileSync(pipeline, readFileSync(pipeline, 'utf-8')
    .replace(/^- \[ \] https:\/\/jobs\.lever\.co\/beta\/2 .*\n/m, '')
    .replace('\n\n## Processed', '\n- [ ] https://x.test/lambda/11 | Lambda Cloud | Data Engineer | Chicago, IL | posted: 2026-11-02\n\n## Processed'));
  const facts = join(root, 'data', 'jd-facts.tsv');
  writeFileSync(facts, readFileSync(facts, 'utf-8').replace(/(kappa\/10\t1\t)10\t/, '$14\t'));

  const day3 = run(new Date('2026-11-02T15:00:00Z'));
  assert.deepEqual(day3.fresh, ['Lambda Cloud'], 'Acme, Iota and Theta were mailed on day 0');
  assert.deepEqual(day3.upgraded, ['Kappa Logistics'], 'seen while gated, now in a top band');
  assert.equal(day3.quiet, false);

  const day4 = run(new Date('2026-11-03T15:00:00Z'));
  assert.deepEqual([day4.fresh, day4.upgraded, day4.quiet], [[], [], true], 'nothing changed, so no mail');

  // The calendar keys its event on the posting, so a row picked on two days
  // collides with itself (409) instead of booking a second slot.
  const cal = calendarConfig(cfg);
  const acme = m => m.rows.find(r => r.c === 'Acme Data');
  assert.equal(eventFor(acme(day0.model), cal, new Date('2026-10-30T15:00:00Z')).id,
    eventFor(acme(day3.model), cal, new Date('2026-11-02T15:00:00Z')).id);
});
