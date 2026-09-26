// tests/trust-validation-all-scanners.test.mjs — trust flags are applied at
// the shared pipeline write path (appendToPipeline), not only in scan.mjs's
// own flow, so the same posting carries the same flags no matter which
// scanner found it. scan-ats-full.mjs, scan-hn.mjs, scan-interamt.mjs and
// plugins.mjs all import appendToPipeline and hand it raw offers; before the
// fix only scan.mjs's flow ran the validator, so a suspicious posting entered
// pipeline.md flagged or unflagged depending on which CLI found it.
//
// Spawns a driver per case rather than importing scan.mjs in-process: the
// pipeline/portals paths resolve against the child's cwd, and a fresh process
// per case keeps each fixture's portals.yml authoritative (same reasoning as
// tests/scan-output-paths.test.mjs).
import { pass, fail, ROOT, NODE, rmTemp } from './helpers.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { execFileSync } from 'child_process';

console.log('\nappendToPipeline — trust validation reaches every pipeline writer');

const SCAN_URL = pathToFileURL(join(ROOT, 'scan.mjs')).href;

// What every non-scan.mjs writer does: hand raw offers straight to
// appendToPipeline. Offers arrive as JSON on argv so each case states its own.
const DRIVER = `import { appendToPipeline } from ${JSON.stringify(SCAN_URL)};
await appendToPipeline(JSON.parse(process.argv[2]));
`;

// Cleared before each spawn so an ambient second-lane environment cannot
// redirect a fixture's writes into real user files (#2568).
const PATH_VARS = ['CAREER_OPS_PORTALS', 'CAREER_OPS_PROFILE', 'CAREER_OPS_PIPELINE', 'CAREER_OPS_SCAN_HISTORY', 'CAREER_OPS_DATA_DIR', 'CAREER_OPS_TRACKER'];

/** Tmp fixture repo + driver; portalsYml === null → no portals.yml at all. */
function makeFixture(portalsYml) {
  const dir = mkdtempSync(join(tmpdir(), 'trust-all-scanners-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  if (portalsYml !== null) writeFileSync(join(dir, 'portals.yml'), portalsYml);
  const driver = join(dir, 'driver.mjs');
  writeFileSync(driver, DRIVER);
  return { dir, driver };
}

function runDriver(dir, driver, offers) {
  const env = { ...process.env };
  for (const v of PATH_VARS) delete env[v];
  // scan.mjs anchors user-layer paths at the data root, not cwd.
  env.CAREER_OPS_ROOT = dir;
  execFileSync(NODE, [driver, JSON.stringify(offers)], {
    cwd: dir, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return readFileSync(join(dir, 'data', 'pipeline.md'), 'utf-8');
}

// Suspicious domain (bit.ly) + company ↔ domain mismatch → score 60, both flags.
const OFFER = { url: 'https://bit.ly/great-job', company: 'Acme Robotics', title: 'AI Engineer' };

// 1. trust_filter enabled → flags land on the pipeline line, whichever entry
//    point appended it.
{
  const { dir, driver } = makeFixture('trust_filter:\n  enabled: true\n');
  try {
    const pipeline = runDriver(dir, driver, [OFFER]);
    if (pipeline.includes('trust: 60 suspicious_domain,company_domain_mismatch')) {
      pass('an offer appended via appendToPipeline carries trust flags without going through scan.mjs');
    } else {
      fail(`trust flags missing from the shared append path: ${JSON.stringify(pipeline)}`);
    }
  } catch (err) {
    fail(`enabled-config driver failed: ${err.message}`);
  } finally {
    rmTemp(dir);
  }
}

// 2. Exactly once: an offer that already carries a trustScore (scan.mjs
//    pre-validates its own flow) is not re-scored by appendToPipeline.
{
  const { dir, driver } = makeFixture('trust_filter:\n  enabled: true\n');
  try {
    const pipeline = runDriver(dir, driver, [{ ...OFFER, trustScore: 100, trustFlags: [], trustLevel: 'high' }]);
    if (!pipeline.includes('trust:')) {
      pass('a pre-validated offer is not re-scored at the shared append path (applied exactly once)');
    } else {
      fail(`appendToPipeline re-validated an offer scan.mjs already scored: ${JSON.stringify(pipeline)}`);
    }
  } catch (err) {
    fail(`pre-validated driver failed: ${err.message}`);
  } finally {
    rmTemp(dir);
  }
}

// 3. trust_filter disabled → same offer, no flags.
{
  const { dir, driver } = makeFixture('trust_filter:\n  enabled: false\n');
  try {
    const pipeline = runDriver(dir, driver, [OFFER]);
    if (pipeline.includes('- [ ] https://bit.ly/great-job | Acme Robotics | AI Engineer') && !pipeline.includes('trust:')) {
      pass('with trust_filter disabled the same offer carries no flags');
    } else {
      fail(`disabled trust_filter still produced flags (or dropped the row): ${JSON.stringify(pipeline)}`);
    }
  } catch (err) {
    fail(`disabled-config driver failed: ${err.message}`);
  } finally {
    rmTemp(dir);
  }
}

// 4. No portals.yml at all → degrades to no flags, never throws.
{
  const { dir, driver } = makeFixture(null);
  try {
    const pipeline = runDriver(dir, driver, [OFFER]);
    if (pipeline.includes('- [ ] https://bit.ly/great-job | Acme Robotics | AI Engineer') && !pipeline.includes('trust:')) {
      pass('a missing portals.yml degrades to no flags instead of throwing');
    } else {
      fail(`missing portals.yml changed the appended row: ${JSON.stringify(pipeline)}`);
    }
  } catch (err) {
    fail(`missing-portals driver threw: ${err.message}`);
  } finally {
    rmTemp(dir);
  }
}
