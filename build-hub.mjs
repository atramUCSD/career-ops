#!/usr/bin/env node
// @ts-check
/**
 * build-hub.mjs — the entry page in front of the per-profile artifacts.
 *
 * Each person's pipeline artifact is its own page at its own URL, because a
 * single page holding everyone's rows would put one person's targeting, comp
 * floor and shortlist in another person's page source. The hub is what makes
 * that split usable: it names who exists, how much is waiting for each of them,
 * when their page was last rebuilt, and where it lives.
 *
 * The hub itself carries NO job data. No company names, no titles, no URLs from
 * anyone's pipeline — only a profile name, a count, a timestamp and a link.
 * That is the whole reason the split exists, so it is a rule about this file and
 * not a coincidence of the current layout: if a future column needs a posting to
 * fill it, that column belongs on the profile's own page.
 *
 *   node build-hub.mjs [--out output/hub.html]
 *
 * Published URLs come from `config/artifacts.yml` (user layer):
 *
 *   owner: https://…              # the repo owner's own artifact
 *   profiles:
 *     sample: https://…
 *
 * A profile with no URL renders as "not yet published" rather than a dead link.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { listProfiles, describe } from './profiles.mjs';
import { buildModel } from './build-artifact.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** Pending checkboxes in a pipeline file. Same shape `describe` counts. */
function pendingIn(path) {
  if (!existsSync(path)) return 0;
  let n = 0;
  for (const line of readFileSync(path, 'utf-8').split('\n')) if (/^\s*[-*]\s*\[ \]/.test(line)) n++;
  return n;
}

/**
 * When the artifact was last rebuilt — the file's own mtime, not the model's
 * `generated` date. The date inside the page says which day the data is from;
 * this says whether the twice-daily rebuild is actually running.
 */
function builtAt(path) {
  if (!existsSync(path)) return null;
  return statSync(path).mtime.toISOString();
}

/**
 * How many rows a profile's own page will actually show.
 *
 * NOT the profile's `data/pipeline.md`, which is normally empty: a profile does
 * not run its own scan, its page is the owner's corpus projected through its
 * targeting. Counting the profile's own pipeline would report every projected
 * profile as 0 pending next to a page showing hundreds of rows.
 *
 * A broken profile config must not take the hub down with it — the whole point
 * of the hub is to still name a profile whose page failed to build.
 */
function projectedCount(root, profileRoot, name) {
  try {
    const m = buildModel({ root, profileRoot, profileName: name });
    return m.projection ? m.projection.kept : m.rows.length;
  } catch {
    return null;
  }
}

export function buildHubModel({ root = ROOT, now = new Date() } = {}) {
  const cfgPath = join(root, 'config/artifacts.yml');
  const cfg = existsSync(cfgPath) ? yaml.load(readFileSync(cfgPath, 'utf-8')) || {} : {};
  const urls = cfg.profiles || {};

  const entries = [{
    name: 'owner',
    label: 'This repository',
    owner: true,
    pending: pendingIn(join(root, 'data/pipeline.md')),
    built: builtAt(join(root, 'output/pipeline-artifact.html')),
    url: cfg.owner || null,
    missing: [],
  }];

  for (const name of listProfiles()) {
    const d = describe(name);
    entries.push({
      name,
      label: name,
      owner: false,
      pending: projectedCount(root, d.dir, name),
      // Both places a profile's page can land: `profiles.mjs artifact` writes
      // inside the profile, the alert script writes into the repo's output/.
      built: builtAt(join(d.dir, 'output/pipeline-artifact.html'))
        || builtAt(join(root, `output/pipeline-${name}.html`)),
      url: urls[name] || null,
      // A profile scoring against a stub CV produces a page that looks finished
      // and is not, so the gap is named on the hub rather than discovered later.
      missing: ['cv', 'profile', 'portals'].filter(k => !d[k]),
    });
  }

  return {
    generated: now.toISOString(),
    entries,
    published: entries.filter(e => e.url).length,
    configured: existsSync(cfgPath),
  };
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** "2026-08-25T18:03:11.000Z" -> "Aug 25, 18:03". Local reading, not a log line. */
function stamp(iso) {
  if (!iso) return 'never built';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function renderHub(M) {
  const cards = M.entries.map(e => {
    const link = e.url
      ? `<a class="open" href="${esc(e.url)}">Open artifact</a>`
      : '<span class="unpub">not yet published</span>';
    const warn = e.missing.length
      ? `<p class="warn">missing ${esc(e.missing.join(', '))} — scores in this profile are provisional</p>`
      : '';
    return `<article class="card${e.owner ? ' own' : ''}">
      <h2>${esc(e.label)}</h2>
      <p class="count"><b>${e.pending === null ? "—" : e.pending}</b> pending</p>
      <p class="built">last build ${esc(stamp(e.built))}</p>
      ${warn}
      <p class="act">${link}</p>
    </article>`;
  }).join('\n');

  return `<meta charset="utf-8">
<title>Pipeline Profiles</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{
  --bg:#f4f6f5; --panel:#ffffff; --ink:#16211f; --dim:#5d6b68; --line:#d8dedb;
  --accent:#0f6b5a; --warn:#a04f2a;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0c1a19; --panel:#122423; --ink:#e6efec; --dim:#95a7a2; --line:#22403c;
    --accent:#4fc7a6; --warn:#e0824f;
  }
}
:root[data-theme="dark"]{
  --bg:#0c1a19; --panel:#122423; --ink:#e6efec; --dim:#95a7a2; --line:#22403c;
  --accent:#4fc7a6; --warn:#e0824f;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-variant-numeric:tabular-nums;padding:40px 20px}
main{max-width:900px;margin:0 auto}
h1{margin:0 0 6px;font-size:26px;letter-spacing:-.01em}
.lede{margin:0 0 28px;color:var(--dim);max-width:62ch}
.cards{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.card.own{border-color:var(--accent)}
.card h2{margin:0 0 10px;font-size:17px}
.count{margin:0;font-size:15px}
.count b{font-size:24px;color:var(--accent)}
.built{margin:2px 0 0;color:var(--dim);font-size:13px}
.warn{margin:8px 0 0;color:var(--warn);font-size:13px}
.act{margin:14px 0 0}
.open{color:var(--accent);font-weight:600;text-decoration:none;border-bottom:1px solid currentColor}
.open:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.unpub{color:var(--dim);font-size:13px}
footer{margin-top:32px;color:var(--dim);font-size:13px;max-width:62ch}
</style>
<main>
<h1>Pipeline Profiles</h1>
<p class="lede">One page per person. This index carries names, counts and links only — no postings, no companies. Open a profile to see its pipeline.</p>
<div class="cards">
${cards}
</div>
<footer>
Generated ${esc(M.generated.slice(0, 16).replace('T', ' '))} UTC · ${M.published} of ${M.entries.length} published.
${M.configured ? '' : 'No <code>config/artifacts.yml</code> yet, so no links are known.'}
</footer>
</main>
`;
}

function main(argv) {
  const outIdx = argv.indexOf('--out');
  const out = resolve(outIdx >= 0 ? argv[outIdx + 1] : join(ROOT, 'output/hub.html'));
  const model = buildHubModel({});
  writeFileSync(out, renderHub(model));
  console.log(`${out} — ${model.entries.length} profiles, ${model.published} published`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
