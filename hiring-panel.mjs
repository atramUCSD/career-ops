#!/usr/bin/env node

/**
 * hiring-panel.mjs — the run-folder format of modes/hiring-panel.md, owned in one place.
 *
 * The mode's seven readers are LLM subagents. Everything after their replies
 * is deterministic and lives here: checking each reply against the output
 * contract, merging and ranking the findings, and reading a run back. The
 * merge used to be prose the orchestrator followed, so two runs on the same
 * replies could rank differently; a fixed sort key in code cannot.
 *
 * The web dashboard shows runs through readRun()/listRuns() instead of parsing
 * the markdown itself (web/AGENTS.md rule 1), so the writer and the reader of
 * this format cannot drift apart.
 *
 * Zero LLM calls, no network. The only write is 08-defects.md, from `merge`.
 *
 * Usage:
 *   node hiring-panel.mjs merge <run-dir>   # check 01-07 against 00-input.md, write 08-defects.md
 *   node hiring-panel.mjs show <run-dir>    # print the run as JSON
 *
 * <run-dir> resolves against the data root, e.g. output/.hiring-panel/2026-10-12-acme.
 * A contract violation exits 1 and names the reply file, so the mode can
 * re-dispatch exactly that reader.
 */

import { createHash } from 'crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import { validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const USAGE = `Usage:
  node hiring-panel.mjs merge <run-dir>   Check 01-07 against 00-input.md, write 08-defects.md
  node hiring-panel.mjs show <run-dir>    Print the run as JSON

<run-dir> resolves against the data root (output/.hiring-panel/{date}-{slug}).`;

/** verdicts[0] is the outcome the candidate wants. */
export const READERS = [
  { id: '01', file: '01-ats.md', short: 'ATS', verdicts: ['PASS', 'REJECT'] },
  { id: '02', file: '02-hm-10s.md', short: 'HM 10s', verdicts: ['INTERVIEW', 'NO'] },
  { id: '03', file: '03-hm-full.md', short: 'HM', verdicts: ['ADVANCE', 'PASS-ON'] },
  // The competing applicant's win is the candidate's loss.
  { id: '04', file: '04-competitor.md', short: 'Rival', verdicts: ['THEY-WIN', 'I-WIN'] },
  { id: '05', file: '05-ceo.md', short: 'CEO', verdicts: ['WORTH-IT', 'NOT'] },
  { id: '06', file: '06-recruiter.md', short: 'Recruiter', verdicts: ['FORWARD', 'DROP'] },
  { id: '07', file: '07-teammate.md', short: 'Teammate', verdicts: ['WANT', "DON'T"] },
];

export const CATEGORIES = ['parse', 'dates', 'keyword', 'lede', 'altitude', 'impact', 'proof', 'scope', 'redundancy', 'jargon', 'logistics', 'format'];

const ATS_AFTER = { ...READERS[0], file: '10-ats.after.md' };
const DISPOSITIONS = ['pending', 'fix', 'needs-user', 'wontfix'];
const stem = (reader) => reader.file.replace(/\.md$/, '');
const lineNo = (id) => Number(id.slice(1));
// Row fields are joined with ' -- ', so no field may contain '--'.
const clean = (s) => String(s).replace(/\s+/g, ' ').replace(/--/g, '-').trim();

/**
 * Parse one reader's reply against the output contract in modes/hiring-panel.md.
 * Strict on purpose: a row that does not parse is a finding the merge would
 * otherwise lose without a trace.
 *
 * @param {string} text
 * @param {{file: string, verdicts: string[]}} reader
 * @returns {{verdict: string, decidedBy: string[], decidedWhy: string,
 *   findings: {line: string, sev: number, category: string, problem: string, fix: string}[],
 *   jdCheck: {requirement: string, present: boolean}[]}}
 * @throws {Error} message starts with the reply's file name.
 */
export function parseReply(text, reader) {
  const bad = (n, why) => { throw new Error(`${reader.file}: ${n ? `line ${n}: ` : ''}${why}`); };
  const out = { verdict: null, decidedBy: [], decidedWhy: '', findings: [], jdCheck: [] };
  let section = null;
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith('```') || /^-\s*none$/i.test(line)) return;
    let m;
    if ((m = line.match(/^VERDICT:\s*(\S+)$/))) {
      if (!reader.verdicts.includes(m[1])) bad(n, `verdict "${m[1]}" is not ${reader.verdicts.join(' or ')}`);
      out.verdict = m[1];
      section = null;
    } else if ((m = line.match(/^DECIDED BY:\s*(.*)$/))) {
      const [ids, ...why] = m[1].split(/\s+(?:--|—|–)\s+/);
      out.decidedBy = ids.match(/L\d{3,}/g) ?? bad(n, 'DECIDED BY cites no line ID');
      out.decidedWhy = why.join(' - ');
      section = null;
    } else if (/^FINDINGS:\s*(none)?$/i.test(line)) {
      section = 'findings';
    } else if (/^JD CHECK\b[^:]*:\s*(none)?$/i.test(line)) {
      section = 'jd';
    } else if (section === 'findings' && line.startsWith('-')) {
      const parts = line.replace(/^-\s*/, '').split('|').map((s) => s.trim());
      if (parts.length < 5) bad(n, 'a finding is "- L### | sev N | category | problem | fix"');
      const [id, sev, category, problem, ...fix] = parts;
      if (!/^L\d{3,}$/.test(id)) bad(n, `"${id}" is not a line ID`);
      const s = sev.match(/^sev\s*([1-3])$/i) ?? bad(n, `"${sev}" is not sev 1-3`);
      if (!CATEGORIES.includes(category.toLowerCase())) bad(n, `unknown category "${category}"`);
      if (!problem || !fix.join('').trim()) bad(n, 'empty problem or fix');
      out.findings.push({ line: id, sev: Number(s[1]), category: category.toLowerCase(), problem, fix: fix.join(' | ') });
    } else if (section === 'jd' && line.startsWith('-') && reader.id !== '01') {
      // Every reader sees the contract's JD CHECK template, labelled ATS-only; merge reads only the ATS's rows.
    } else if (section === 'jd' && line.startsWith('-')) {
      m = line.match(/^-\s*(.+?)\s*\|\s*(present\s+L\d{3,}(?:\s*,\s*L\d{3,})*|missing)$/i)
        ?? bad(n, 'a JD CHECK row is "- requirement | present L###" or "- requirement | missing"');
      out.jdCheck.push({ requirement: m[1], present: !/^missing$/i.test(m[2]) });
    } else {
      bad(n, `outside the contract: "${line.slice(0, 60)}"`);
    }
  });
  if (!out.verdict) bad(0, 'no VERDICT line');
  if (!out.decidedBy.length) bad(0, 'no DECIDED BY line');
  return out;
}

const HEADER = {
  Source: 'source', 'SHA-256': 'sha256', Report: 'report', JD: 'jd',
  Extraction: 'extraction', Isolation: 'isolation', 'Must-haves': 'mustHaves',
};

/**
 * Parse 00-input.md: the header, `## Slices` (which lines each reader was
 * given) and `## Text` (the numbered resume). Later sections are ignored.
 *
 * @param {string} text
 * @returns {{meta: {source: string, sha256: string, report: number|null, jd: string,
 *   extraction: string, isolated: boolean, mustHaves: number},
 *   lines: Set<string>, slices: Map<string, Set<string>|'all'>}}
 */
export function parseInput(text) {
  const bad = (why) => { throw new Error(`00-input.md: ${why}`); };
  const raw = {};
  const lines = new Set();
  const slices = new Map();
  let section = 'header';
  for (const l of String(text).split(/\r?\n/)) {
    const line = l.trim();
    const h = line.match(/^##\s+(.+)$/);
    if (h) { section = h[1].trim().toLowerCase(); continue; }
    if (!line) continue;
    if (section === 'header') {
      const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
      if (m && HEADER[m[1]]) raw[HEADER[m[1]]] = m[2].trim();
    } else if (section === 'slices') {
      const m = line.match(/^(\d{2}-[a-z0-9-]+):\s*(.+)$/) ?? bad(`slice line "${line}"`);
      if (m[2].trim().toLowerCase() === 'all') { slices.set(m[1], 'all'); continue; }
      const ids = new Set();
      for (const part of m[2].split(',')) {
        const r = part.trim().match(/^L(\d{3,})(?:\s*-\s*L(\d{3,}))?$/) ?? bad(`slice "${part.trim()}" for ${m[1]}`);
        for (let i = Number(r[1]); i <= Number(r[2] ?? r[1]); i++) ids.add(`L${String(i).padStart(3, '0')}`);
      }
      slices.set(m[1], ids);
    } else if (section === 'text') {
      const m = line.match(/^(L\d{3,})\b/);
      if (m) lines.add(m[1]);
    }
  }
  for (const [label, key] of Object.entries(HEADER)) if (raw[key] === undefined) bad(`missing header "${label}:"`);
  const report = /^none$/i.test(raw.report) ? null : Number(raw.report.match(/^#?(\d+)$/)?.[1] ?? bad(`Report "${raw.report}" is not a number or "none"`));
  if (!/^\d+$/.test(raw.mustHaves)) bad(`Must-haves "${raw.mustHaves}" is not a count`);
  if (!/^(isolated|inline)\b/.test(raw.isolation)) bad(`Isolation "${raw.isolation}" is not "isolated -- 7 subagents" or "inline -- not isolated"`);
  for (const r of READERS) if (!slices.has(stem(r))) bad(`no slice for ${stem(r)}`);
  if (!lines.size) bad('## Text has no numbered lines');
  const meta = {
    source: raw.source, sha256: raw.sha256.toLowerCase(), report, jd: raw.jd, extraction: raw.extraction,
    isolated: raw.isolation.startsWith('isolated'), mustHaves: Number(raw.mustHaves),
  };
  return { meta, lines, slices };
}

/**
 * Group findings by (line, category) and rank them with the mode's Step 3 key:
 * ATS REJECT and in its DECIDED BY; readers raising it; highest severity; in
 * any DECIDED BY; earlier line. Findings citing a line the reader was not
 * given are dropped, not merged.
 *
 * @param {ReturnType<typeof parseInput>} input
 * @param {Record<string, ReturnType<typeof parseReply>>} replies keyed by reader id ('01'..'07')
 */
export function mergeFindings(input, replies) {
  const groups = new Map();
  const dropped = [];
  const decided = new Set();
  const ats = replies['01'];
  const atsRejects = new Set(ats?.verdict === 'REJECT' ? ats.decidedBy : []);
  for (const r of READERS) {
    const reply = replies[r.id];
    if (!reply) continue;
    const slice = input.slices.get(stem(r));
    const given = slice === 'all' ? input.lines : slice;
    for (const id of reply.decidedBy) if (given.has(id)) decided.add(id);
    for (const f of reply.findings) {
      if (!given.has(f.line)) { dropped.push({ reader: r.id, ...f }); continue; }
      const key = `${f.line}|${f.category}`;
      if (!groups.has(key)) groups.set(key, { line: f.line, category: f.category, raised: [] });
      groups.get(key).raised.push({ reader: r.id, ...f });
    }
  }
  const defects = [...groups.values()].map(({ line, category, raised }) => {
    const readers = [...new Set(raised.map((f) => f.reader))];
    // Ties keep the earlier reader, so the wording is stable across runs.
    const top = raised.reduce((a, b) => (b.sev > a.sev ? b : a));
    const cuts = raised.filter((f) => /^cut\b/i.test(f.fix)).length;
    // ponytail: a conflict is "one reader cuts, another keeps" on the same line
    // and category. Opposite reframes, or a cut and a keep filed under different
    // categories (the CEO's jargon vs the teammate's proof), are not caught;
    // compare fixes per line across categories if real runs show that shape.
    const split = cuts > 0 && cuts < raised.length;
    const fixes = [...new Map(raised.map((f) => [f.fix, `${f.fix} (${f.reader})`])).values()];
    return {
      n: 0, line, category, problem: top.problem, readers, k: readers.length, sev: top.sev,
      atsDecides: atsRejects.has(line), decides: decided.has(line),
      fix: split ? fixes.join(' / ') : top.fix, split, disposition: 'pending', note: null,
    };
  });
  defects.sort((a, b) => (b.atsDecides - a.atsDecides) || (b.k - a.k) || (b.sev - a.sev)
    || (b.decides - a.decides) || (lineNo(a.line) - lineNo(b.line)) || a.category.localeCompare(b.category));
  defects.forEach((d, i) => { d.n = i + 1; });
  return { defects, dropped };
}

/** One 08-defects.md row: `N. [L###] category -- problem -- raised by 02,05 (2/7) -- fix -- disposition`. */
export function formatDefect(d) {
  const fix = `${d.split ? 'split: ' : ''}${clean(d.fix)}`;
  const disposition = d.note ? `${d.disposition}: ${clean(d.note)}` : d.disposition;
  return `${d.n}. [${d.line}] ${d.category} -- ${clean(d.problem)} -- raised by ${d.readers.join(',')} (${d.k}/7) -- ${fix} -- ${disposition}`;
}

export function formatDefects(defects, dropped = []) {
  return [
    '# Hiring panel defects',
    '',
    'Ranked by `node hiring-panel.mjs merge` (modes/hiring-panel.md Step 3). Replace `pending` in place with `fix`, `needs-user: <question>` or `wontfix: <reason>`.',
    '',
    ...defects.map(formatDefect),
    ...(dropped.length
      ? ['', '## Dropped', '', 'Findings citing a line the reader was not given.', '',
        ...dropped.map((f) => `- ${f.reader} [${f.line}] ${f.category}: ${clean(f.problem)}`)]
      : []),
    '',
  ].join('\n');
}

/**
 * Parse 08-defects.md. The disposition is hand-edited by the orchestrator, so
 * a row that no longer matches is reported in `problems`, never skipped quietly.
 */
export function parseDefects(text) {
  const defects = [];
  const problems = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const head = line.match(/^(\d+)\.\s/);
    if (!head) continue;
    const m = line.match(/^(\d+)\. \[(L\d{3,})\] ([a-z]+) -- (.*)$/);
    const parts = m ? m[4].split(' -- ') : [];
    const by = parts[1]?.match(/^raised by (\d{2}(?:,\d{2})*) \((\d+)\/7\)$/);
    // A free-text disposition may itself contain ' -- '; everything after the fix is the disposition.
    const disp = parts.length >= 4 ? parts.slice(3).join(' -- ').match(/^([a-z-]+)(?::\s*(.*))?$/i) : null;
    const kind = disp?.[1].toLowerCase();
    if (!m || !by || !DISPOSITIONS.includes(kind)) {
      problems.push(`08-defects.md row ${head[1]} does not match "N. [L###] category -- problem -- raised by NN (k/7) -- fix -- disposition"`);
      continue;
    }
    if ((kind === 'needs-user' || kind === 'wontfix') && !disp[2]?.trim()) {
      problems.push(`08-defects.md row ${head[1]}: ${kind} needs ${kind === 'wontfix' ? 'a reason' : 'a question'}`);
    }
    const split = parts[2].startsWith('split: ');
    defects.push({
      n: Number(m[1]), line: m[2], category: m[3], problem: parts[0], readers: by[1].split(','), k: Number(by[2]),
      fix: split ? parts[2].slice('split: '.length) : parts[2], split, disposition: kind, note: disp[2]?.trim() || null,
    });
  }
  return { defects, problems };
}

/**
 * Summarize one run folder for display. A missing file means the run is still
 * in progress; a malformed one is listed in `problems` (web/AGENTS.md: a
 * missing file is not a malformed file). Never throws for a bad run.
 *
 * @param {string} dir run folder
 * @param {{root?: string}} [opts] data root that a relative `Source:` resolves against
 */
export function readRun(dir, { root = getCareerOpsRoot() } = {}) {
  const name = basename(dir);
  const run = {
    dir: name, date: name.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null, meta: null, verdicts: [],
    ats: { before: null, after: null, missingBefore: null, missingAfter: null },
    defects: null, questions: 0, sourceChanged: null, problems: [],
  };
  const read = (file) => {
    const p = join(dir, file);
    try {
      // lstat, not stat: a symlink planted in output/ must not pull an outside file into the dashboard.
      if (!lstatSync(p).isFile()) { run.problems.push(`${file} is not a regular file`); return null; }
      return readFileSync(p, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') run.problems.push(`${file}: ${e.code ?? e.message}`);
      return null;
    }
  };

  const inputText = read('00-input.md');
  if (inputText === null) { run.problems.push('00-input.md is missing'); return run; }
  try {
    run.meta = parseInput(inputText).meta;
  } catch (e) {
    run.problems.push(e.message);
    return run;
  }

  const atsRead = (reader, key) => {
    const text = read(reader.file);
    if (text === null) return null;
    try {
      const reply = parseReply(text, reader);
      run.ats[key === 'before' ? 'before' : 'after'] = reply.verdict;
      run.ats[key === 'before' ? 'missingBefore' : 'missingAfter'] = reply.jdCheck.filter((c) => !c.present).length;
      if (reply.jdCheck.length !== run.meta.mustHaves) {
        run.problems.push(`${reader.file}: JD CHECK has ${reply.jdCheck.length} rows, Must-haves is ${run.meta.mustHaves}`);
      }
      return reply;
    } catch (e) {
      run.problems.push(e.message);
      return null;
    }
  };
  for (const r of READERS) {
    let reply;
    if (r.id === '01') reply = atsRead(r, 'before');
    else {
      const text = read(r.file);
      if (text === null) continue;
      try { reply = parseReply(text, r); } catch (e) { run.problems.push(e.message); }
    }
    if (reply) run.verdicts.push({ id: r.id, short: r.short, verdict: reply.verdict, good: reply.verdict === r.verdicts[0] });
  }
  atsRead(ATS_AFTER, 'after');

  const defectsText = read('08-defects.md');
  if (defectsText !== null) {
    const { defects, problems } = parseDefects(defectsText);
    run.defects = defects;
    run.questions = defects.filter((d) => d.disposition === 'needs-user').length;
    run.problems.push(...problems);
  }

  if (/^[0-9a-f]{64}$/.test(run.meta.sha256) && !/^pasted\b/i.test(run.meta.source)) {
    try {
      const hash = createHash('sha256').update(readFileSync(resolve(root, run.meta.source))).digest('hex');
      run.sourceChanged = hash !== run.meta.sha256;
    } catch (e) {
      if (e.code !== 'ENOENT') run.problems.push(`source ${run.meta.source}: ${e.code ?? e.message}`);
    }
  }
  return run;
}

/** Every run under `panelDir` (output/.hiring-panel), newest first. A missing folder is no runs. */
export function listRuns(panelDir, opts) {
  let entries;
  try {
    entries = readdirSync(panelDir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  // Numeric collation so `-10` sorts after `-2` on the same date and slug.
  const order = new Intl.Collator('en', { numeric: true }).compare;
  return entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}-/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => order(b, a))
    .map((name) => readRun(join(panelDir, name), opts));
}

/**
 * The newest run per report number, and the newest master-CV run (no report,
 * source cv.md). `runs` must be newest first, as listRuns returns them.
 */
export function indexRuns(runs) {
  const byReport = new Map();
  let master = null;
  for (const run of runs) {
    if (!run.meta) continue;
    if (run.meta.report !== null) {
      if (!byReport.has(run.meta.report)) byReport.set(run.meta.report, run);
    } else if (!master && basename(run.meta.source) === 'cv.md') {
      master = run;
    }
  }
  return { byReport, master };
}

/** The `merge` command. Throws with the file to fix in the message. */
export function mergeRun(dir) {
  const inputPath = join(dir, '00-input.md');
  if (!existsSync(inputPath)) throw new Error(`00-input.md: missing in ${dir}`);
  const input = parseInput(readFileSync(inputPath, 'utf8'));
  const replies = {};
  for (const r of READERS) {
    const p = join(dir, r.file);
    if (!existsSync(p)) throw new Error(`${r.file}: missing; dispatch this reader`);
    replies[r.id] = parseReply(readFileSync(p, 'utf8'), r);
  }
  const rows = replies['01'].jdCheck.length;
  if (rows !== input.meta.mustHaves) {
    throw new Error(`01-ats.md: JD CHECK has ${rows} rows, 00-input.md declares Must-haves: ${input.meta.mustHaves}; re-dispatch for the missing rows`);
  }
  const out = join(dir, '08-defects.md');
  if (existsSync(out)) {
    const prior = parseDefects(readFileSync(out, 'utf8'));
    if (prior.problems.length || prior.defects.some((d) => d.disposition !== 'pending')) {
      throw new Error('08-defects.md: already dispositioned; move it aside before merging again');
    }
  }
  const merged = mergeFindings(input, replies);
  writeFileSync(out, formatDefects(merged.defects, merged.dropped));
  return merged;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, ['--help', '-h'], USAGE);
  const [cmd, target] = args;
  if (!['merge', 'show'].includes(cmd) || !target || args.length > 2) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    const dir = resolve(getCareerOpsRoot(), target);
    try {
      if (cmd === 'merge') {
        const { defects, dropped } = mergeRun(dir);
        console.log(`08-defects.md: ${defects.length} defects, ${dropped.length} dropped`);
      } else {
        console.log(JSON.stringify(readRun(dir), null, 2));
      }
    } catch (e) {
      console.error(`hiring-panel: ${e.message}`);
      process.exitCode = 1;
    }
  }
}
