// hiring-panel.mjs owns the run-folder format of modes/hiring-panel.md. These
// cases pin the merge's rank key, the slice check, the row round-trip and the
// CLI's refusals on a synthetic run (invented text, no user data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  READERS, formatDefects, indexRuns, listRuns, mergeFindings, parseDefects, parseInput, parseReply, readRun,
} from '../hiring-panel.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CV = '# Sam Example\n\nPlatform engineer.\n';

function input({ report = 'none', mustHaves = 2, source = 'cv.md', sha = createHash('sha256').update(CV).digest('hex') } = {}) {
  return [
    '# Hiring panel input',
    '',
    `Source: ${source}`,
    `SHA-256: ${sha}`,
    `Report: ${report}`,
    'JD: jds/example.md',
    'Extraction: as is',
    'Isolation: isolated -- 7 subagents',
    `Must-haves: ${mustHaves}`,
    '',
    '## Slices',
    '01-ats: all',
    '02-hm-10s: L001-L003',
    '03-hm-full: all',
    '04-competitor: all',
    '05-ceo: L001, L003',
    '06-recruiter: L001-L002',
    '07-teammate: all',
    '',
    '## Text',
    'L001 Sam Example',
    'L002 Platform Engineer, Example Co, 2021-2024',
    'L003 Built a deploy tool',
    'L004 Moved services to a new cluster',
    'L005 Skills: Go, Kubernetes',
    '',
    '## jd-skill-gap',
    'gap: none',
  ].join('\n');
}

function reply(verdict, decided, findings = [], jd = null) {
  return [
    `VERDICT: ${verdict}`,
    `DECIDED BY: ${decided} -- one line`,
    'FINDINGS:',
    ...(findings.length ? findings.map((f) => `- ${f}`) : ['- none']),
    ...(jd ? ['JD CHECK (ATS reader only, one row per must-have):', ...jd.map((r) => `- ${r}`)] : []),
  ].join('\n');
}

const REPLIES = {
  '01': reply('REJECT', 'L002', ['L002 | sev 3 | dates | dates not splittable | reorder to start-end'], ['Go | present L005', 'Terraform | missing']),
  '02': reply('NO', 'L003', ['L003 | sev 2 | lede | opens on tooling | reframe around the result']),
  '03': reply('ADVANCE', 'L004', ['L003 | sev 3 | lede | tool, not outcome | reframe', 'L004 | sev 2 | impact | no scale | NEEDS-FACT: how many services?']),
  '04': reply('I-WIN', 'L004', ['L004 | sev 1 | impact | vague | reframe']),
  '05': reply('NOT', 'L003', ['L003 | sev 1 | jargon | deploy tool means nothing | cut the tool name', 'L004 | sev 3 | impact | out of slice | cut']),
  '06': reply('FORWARD', 'L001', ['L002 | sev 1 | logistics | no location | keyword']),
  '07': reply('WANT', 'L005', ['L003 | sev 2 | jargon | name the tool | keep it, name the version']),
};

function fixture(t, { report = 'none', replies = REPLIES, mustHaves = 2, source = 'cv.md' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'career-ops-hiring-panel-')));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  writeFileSync(join(root, 'cv.md'), CV);
  const panel = join(root, 'output', '.hiring-panel');
  const dir = join(panel, '2026-10-12-example');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '00-input.md'), input({ report, mustHaves, source }));
  for (const r of READERS) if (replies[r.id] !== undefined) writeFileSync(join(dir, r.file), replies[r.id]);
  return { root, panel, dir };
}

function cli(root, ...args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'hiring-panel.mjs'), ...args], {
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '' }, encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(r.error);
  return r;
}

const parsed = (replies = REPLIES) => Object.fromEntries(READERS.map((r) => [r.id, parseReply(replies[r.id], r)]));

test('rank: a line the ATS rejected on outranks reader count; then severity; then line order', () => {
  const { defects, dropped } = mergeFindings(parseInput(input()), parsed());
  assert.deepEqual(defects.map((d) => `${d.line}/${d.category}/${d.k}`), [
    'L002/dates/1', // ATS REJECT, DECIDED BY L002
    'L002/logistics/1', // same line, so it is also on the line that got the resume rejected
    'L003/lede/2', // two readers, sev 3
    'L003/jargon/2', // two readers, sev 2, decided; earlier line than the next
    'L004/impact/2',
  ]);
  assert.deepEqual(defects.map((d) => d.n), [1, 2, 3, 4, 5]);
  assert.deepEqual(dropped.map((f) => `${f.reader} ${f.line}`), ['05 L004'], 'the CEO was not given L004');
});

test('rank: reader count beats severity, severity beats DECIDED BY, DECIDED BY beats line order, then category', () => {
  const replies = { ...REPLIES };
  replies['01'] = reply('PASS', 'L001', [], ['Go | present L005', 'Terraform | present L005']);
  for (const id of ['02', '05', '06']) replies[id] = reply(READERS[Number(id) - 1].verdicts[0], 'L001');
  replies['03'] = reply('ADVANCE', 'L001', ['L002 | sev 3 | impact | x | reframe']);
  replies['04'] = reply('THEY-WIN', 'L001', ['L005 | sev 1 | redundancy | x | cut']);
  replies['07'] = reply('WANT', 'L005', [
    'L005 | sev 1 | redundancy | x | cut', 'L005 | sev 1 | format | x | reframe',
    'L004 | sev 1 | scope | x | reframe', 'L004 | sev 1 | proof | x | reframe',
  ]);
  const { defects } = mergeFindings(parseInput(input()), parsed(replies));
  assert.deepEqual(defects.map((d) => `${d.line}/${d.category}`), ['L005/redundancy', 'L002/impact', 'L005/format', 'L004/proof', 'L004/scope']);
});

test('split marks a cut against a keep on one line and category', () => {
  const { defects } = mergeFindings(parseInput(input()), parsed());
  const jargon = defects.find((d) => d.line === 'L003' && d.category === 'jargon');
  assert.equal(jargon.split, true);
  assert.equal(jargon.fix, 'cut the tool name (05) / keep it, name the version (07)');
  assert.equal(defects.find((d) => d.category === 'lede').split, false);
});

test('08-defects.md rows round-trip, including hand-edited dispositions', () => {
  const { defects, dropped } = mergeFindings(parseInput(input()), parsed());
  defects[0].problem = 'a -- b';
  defects[1].disposition = 'needs-user';
  defects[1].note = 'How many services -- roughly?';
  const text = formatDefects(defects, dropped);
  assert.match(text, /^1\. \[L002\] dates -- a - b -- raised by 01 \(1\/7\) -- /m);
  const back = parseDefects(text);
  assert.deepEqual(back.problems, []);
  assert.equal(back.defects.length, defects.length);
  for (const [i, d] of back.defects.entries()) {
    for (const k of ['n', 'line', 'category', 'readers', 'k', 'split', 'disposition']) assert.deepEqual(d[k], defects[i][k], `${k} of row ${i + 1}`);
  }
  assert.equal(back.defects[1].note, 'How many services - roughly?');
  // An orchestrator edit that breaks the row is surfaced, not skipped.
  const broken = parseDefects(text.replace(/-- pending$/m, '-- maybe'));
  assert.equal(broken.problems.length, 1);
  assert.match(broken.problems[0], /row \d+ does not match/);
});

test('parseReply names the reader and the line on a contract violation', () => {
  const hm = READERS[2];
  assert.throws(() => parseReply('VERDICT: MAYBE\nDECIDED BY: L001 -- x\nFINDINGS:', hm), /^Error: 03-hm-full\.md: line 1: verdict "MAYBE"/);
  assert.throws(() => parseReply('VERDICT: ADVANCE\nDECIDED BY: L001 -- x\nFINDINGS:\n- L001 | sev 2 | tone | x | y', hm), /line 4: unknown category "tone"/);
  assert.throws(() => parseReply('VERDICT: ADVANCE\nDECIDED BY: L001 -- x\nFINDINGS:\nLooks good overall.', hm), /line 4: outside the contract/);
  assert.equal(parseReply('```\nVERDICT: ADVANCE\nDECIDED BY: L001, L004 — x\nFINDINGS: none\n```', hm).decidedBy.join(), 'L001,L004');
});

test('merge CLI writes 08-defects.md and refuses to overwrite dispositions', (t) => {
  const f = fixture(t);
  const ok = cli(f.root, 'merge', 'output/.hiring-panel/2026-10-12-example');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /5 defects, 1 dropped/);
  const file = join(f.dir, '08-defects.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/-- pending$/m, '-- fix'));
  const again = cli(f.root, 'merge', f.dir);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already dispositioned/);
});

test('merge CLI exits 1 naming the malformed reader', (t) => {
  const f = fixture(t, { replies: { ...REPLIES, '04': 'I think they lose.' } });
  const r = cli(f.root, 'merge', f.dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /04-competitor\.md: line 1: outside the contract/);
});

test('merge CLI enforces the JD CHECK coverage rule', (t) => {
  const f = fixture(t, { mustHaves: 3 });
  const r = cli(f.root, 'merge', f.dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /01-ats\.md: JD CHECK has 2 rows, 00-input\.md declares Must-haves: 3/);
});

test('readRun: an unmerged run has no defects and no problems; a malformed reply is a problem', (t) => {
  const partial = { ...REPLIES };
  delete partial['07'];
  const f = fixture(t, { replies: partial });
  let run = readRun(f.dir, { root: f.root });
  assert.equal(run.defects, null);
  assert.deepEqual(run.problems, []);
  assert.equal(run.verdicts.length, 6);
  assert.deepEqual(run.ats, { before: 'REJECT', after: null, missingBefore: 1, missingAfter: null });
  assert.equal(run.sourceChanged, false);

  writeFileSync(join(f.dir, '07-teammate.md'), 'VERDICT: MAYBE');
  writeFileSync(join(f.root, 'cv.md'), `${CV}edited\n`);
  run = readRun(f.dir, { root: f.root });
  assert.equal(run.verdicts.length, 6);
  assert.match(run.problems.join('\n'), /07-teammate\.md: line 1: verdict "MAYBE"/);
  assert.equal(run.sourceChanged, true);
});

test('readRun after the merge counts questions; show prints the same JSON', (t) => {
  const f = fixture(t, { report: '7' });
  assert.equal(cli(f.root, 'merge', f.dir).status, 0);
  const file = join(f.dir, '08-defects.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^(2\..*)-- pending$/m, '$1-- needs-user: How many services?'));
  writeFileSync(join(f.dir, '10-ats.after.md'), reply('PASS', 'L002', [], ['Go | present L005', 'Terraform | missing']));
  const run = readRun(f.dir, { root: f.root });
  assert.equal(run.meta.report, 7);
  assert.equal(run.questions, 1);
  assert.equal(run.defects.find((d) => d.n === 2).note, 'How many services?');
  assert.deepEqual(run.ats, { before: 'REJECT', after: 'PASS', missingBefore: 1, missingAfter: 1 });
  assert.deepEqual(run.verdicts.map((v) => `${v.short}:${v.good}`), ['ATS:false', 'HM 10s:false', 'HM:true', 'Rival:false', 'CEO:false', 'Recruiter:true', 'Teammate:true']);
  const shown = cli(f.root, 'show', f.dir);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout), JSON.parse(JSON.stringify(run)));
});

test('listRuns and indexRuns pick the newest run per report and the newest master run', (t) => {
  const f = fixture(t);
  const add = (name, opts) => {
    const dir = join(f.panel, name);
    mkdirSync(dir);
    writeFileSync(join(dir, '00-input.md'), input(opts));
  };
  add('2026-10-01-acme', { report: '009' });
  add('2026-10-05-acme', { report: '9' });
  add('2026-10-12-example-2', { report: 'none', source: 'output/cv-sam-acme.pdf' });
  add('2026-10-12-example-10', {});
  mkdirSync(join(f.panel, 'notes'));
  const runs = listRuns(f.panel, { root: f.root });
  assert.deepEqual(runs.map((r) => r.dir), ['2026-10-12-example-10', '2026-10-12-example-2', '2026-10-12-example', '2026-10-05-acme', '2026-10-01-acme']);
  const { byReport, master } = indexRuns(runs);
  assert.equal(byReport.get(9).dir, '2026-10-05-acme', 'zero-padded and bare report numbers are one key');
  assert.equal(master.dir, '2026-10-12-example-10', 'a non-cv.md source is not a master run');
  assert.deepEqual(listRuns(join(f.root, 'nope')), []);
});
