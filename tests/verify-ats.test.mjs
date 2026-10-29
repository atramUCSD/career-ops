// tests/verify-ats.test.mjs — verify-ats.mjs scoring arithmetic, gate decision,
// keyword normalization, and the CLI's argument handling and exit codes.
//
// The built-in --self-test (run by test-all) pins each check's detection; this
// file pins what it leaves loose: grade boundaries, the score each penalty
// actually costs, isPass's two conditions, and the CLI contract callers read.
//
// Run: node --test tests/verify-ats.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditAts, extractHeadings, extractVisibleText, gradeFor, isPass, normalizeKeywords, DEFAULT_MIN_SCORE,
} from '../verify-ats.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BODY = 'Staff Engineer, Acme Corp (2020-present). Built and operated the core payments platform, '
  + 'reducing incident rates and improving deployment cadence across multiple engineering teams. '
  + 'Python, Kubernetes, Docker, PostgreSQL, distributed systems, CI/CD pipelines, observability.';

/** Every check satisfied, with `extra` appended to the body. Scores exactly 95: no bonus headings.
 *  Over 800 chars of text, so one image reads as decorative rather than text baked in. */
const cv = (extra = '', head = '<meta charset="UTF-8"><style>body{font-family:Arial,sans-serif}</style>') =>
  `<!DOCTYPE html><html><head>${head}</head><body>
<p><a href="mailto:jane@example.com">jane@example.com</a> | +1 415 555 0100</p>
<div class="section-title">Work Experience</div><p>${BODY}</p>
<div class="section-title">Education</div><p>B.S. Computer Science, State University, 2018. ${BODY}</p>
<div class="section-title">Skills</div><p>${BODY}</p>${extra}</body></html>`;

test('gradeFor boundaries', () => {
  assert.deepEqual([100, 90, 89, 80, 79, 70, 69, 60, 59, 0].map(gradeFor), ['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'F', 'F']);
});

test('isPass needs the threshold AND no critical issue', () => {
  assert.equal(isPass({ score: 70, issues: [] }, 70), true);
  assert.equal(isPass({ score: 69, issues: [] }, 70), false);
  assert.equal(isPass({ score: 100, issues: [{ severity: 'critical' }] }, 0), false);
  assert.equal(isPass({ score: 70, issues: [{ severity: 'warning' }, { severity: 'info' }] }, 70), true);
});

test('normalizeKeywords splits role on comma, slash and "and", keeps titles whole, dedupes and drops 1-char terms', () => {
  assert.deepEqual(normalizeKeywords(' python, ,k8s,python,x ', undefined), ['python', 'k8s']);
  assert.deepEqual(normalizeKeywords(undefined, 'Senior Backend Engineer'), ['Senior Backend Engineer']);
  assert.deepEqual(normalizeKeywords(['rag'], 'ML/Data and Platform, SRE'), ['rag', 'ML', 'Data', 'Platform', 'SRE']);
  assert.deepEqual(normalizeKeywords(undefined, undefined), []);
});

test('extractVisibleText drops script/style/comments and does not double-unescape &amp;lt;', () => {
  const text = extractVisibleText('<style>p{}</style><script>x()</script><!-- c --><p>A&nbsp;&amp;lt;b&gt; &amp; C</p>');
  assert.equal(text, 'A &lt;b> & C');
});

test('extractHeadings emits raw and ASCII-folded lowercase forms', () => {
  const h = extractHeadings('<div class="section-title">Comp&eacute;tences</div><h2>スキル</h2>');
  assert.ok(h.includes('compétences') && h.includes('competences'));
  assert.ok(h.includes('スキル'));
});

test('a fully clean CV without bonus headings scores 95; bonus headings cap at +5', () => {
  assert.equal(auditAts(cv()).score, 95);
  const bonus = '<div class="section-title">Summary</div><div class="section-title">Projects</div><div class="section-title">Certifications</div>';
  assert.equal(auditAts(cv(bonus)).score, 100);
});

test('penalties cost what the weights say', () => {
  const base = auditAts(cv()).score;
  const cost = (extra, head) => base - auditAts(cv(extra, head)).score;
  assert.equal(cost('<table><tr><td>x</td></tr></table>'), 12);
  assert.equal(cost('<div style="column-count:3">x</div>'), 8);
  assert.equal(cost('', '<meta charset="UTF-8"><style>body{font-family:Arial,sans-serif} .a{column-count:1} .b{column-count:3}</style>'), 8, 'a later rule still counts');
  assert.equal(cost('<div style="position:absolute">x</div>'), 4);
  assert.equal(cost('<img src="chart.png">'), 5);
  assert.equal(cost('<span style="display:none">kw</span>'), 5);
  assert.equal(cost('', '<style>body{font-family:Arial}</style>'), 5);
  // Each unsafe font costs 3, floored at 0 of the 10-point weight.
  assert.equal(cost('', '<meta charset="UTF-8"><style>body{font-family:Foo}</style>'), 3);
  assert.equal(cost('', '<meta charset="UTF-8"><style>body{font-family:A1,B1,C1,D1,E1}</style>'), 10);
  // Layout penalties sum to 24 against a 20-point weight; the floor keeps it at 20.
  assert.equal(cost('<table></table><div style="columns:2;position:absolute">x</div>'), 20);
});

test('section-heading severity: one missing is a warning, two is critical', () => {
  const one = auditAts(cv().replace('>Skills<', '>Hobbies<'));
  assert.equal(one.issues.find((i) => i.id === 'section-headings').severity, 'warning');
  assert.ok(isPass(one, DEFAULT_MIN_SCORE));
  const two = auditAts(cv().replace('>Skills<', '>Hobbies<').replace('>Education<', '>Travel<'));
  assert.equal(two.issues.find((i) => i.id === 'section-headings').severity, 'critical');
  assert.equal(isPass(two, 0), false);
});

test('white text is matched as a declaration, not as a substring of background-color', () => {
  const ids = (extra) => auditAts(cv(extra)).issues.map((i) => i.id);
  assert.ok(!ids('<span style="background-color:#fff">badge</span>').includes('hidden-text'));
  assert.ok(ids('<span style="font-weight:700; color: rgb(255, 255, 255)">kw</span>').includes('hidden-text'));
  // A ; inside a quoted string does not start a new declaration.
  assert.ok(!ids(`<span style="content:'a;color:#fff'">x</span>`).includes('hidden-text'));
});

test('keyword coverage is case-insensitive, rounded, and score-neutral', () => {
  const r = auditAts(cv(), { keywords: 'PYTHON,rust,golang', role: 'Staff Engineer' });
  assert.deepEqual(r.keywordCoverage, { total: 4, found: 2, percent: 50, missing: ['rust', 'golang'] });
  assert.equal(r.score, auditAts(cv()).score);
});

// ── CLI ─────────────────────────────────────────────────────────────────

function runCli(args) {
  return spawnSync(process.execPath, ['verify-ats.mjs', ...args], { cwd: ROOT, encoding: 'utf-8' });
}

test('CLI: usage, argument errors and exit codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-ats-cli-'));
  try {
    const good = join(dir, 'good.html');
    writeFileSync(good, cv());
    const bad = join(dir, 'bad.html');
    writeFileSync(bad, '<html><body><table><tr><td>hi</td></tr></table></body></html>');

    assert.equal(runCli(['--help']).status, 0);
    assert.equal(runCli([]).status, 1, 'a missing target is a usage error, not help');
    assert.match(runCli([good, '--keywords', '--json']).stderr, /--keywords requires/);
    assert.match(runCli([good, '--min-score', '101']).stderr, /between 0 and 100/);
    assert.match(runCli([good, '--bogus']).stderr, /unknown option: --bogus/);
    assert.match(runCli([good, bad]).stderr, /unexpected extra positional/);
    assert.match(runCli([join(dir, 'nope.html')]).stderr, /cannot read target file/);
    assert.match(runCli([dir]).stderr, /cannot read target file/, 'a directory is not a CV');

    const ok = runCli([good, '--json', '--keywords', 'python']);
    assert.equal(ok.status, 0);
    const json = JSON.parse(ok.stdout);
    assert.equal(json.file, 'good.html');
    assert.equal(json.pass, true);
    assert.equal(json.minScore, DEFAULT_MIN_SCORE);
    assert.equal(json.keywordCoverage.found, 1);

    assert.equal(runCli([good, '--min-score', '96']).status, 1, '95 is below a 96 bar');
    const fail = runCli([bad]);
    assert.equal(fail.status, 1);
    assert.match(fail.stdout, /ATS check failed: bad\.html/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
