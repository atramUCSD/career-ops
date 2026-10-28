// The status-log source sets and the CLI exit numbering live in
// tracker-utils.mjs. A local copy drifts the first time a writer or an exit
// code is added, so this fails on any redefinition in a root script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEDGER_SOURCES, DAY_MATH_SOURCES, WRITER_SOURCES, CLI_EXIT } from '../tracker-utils.mjs';
import { LEDGER_SOURCE as CLOSE_STALE_SOURCE } from '../close-stale.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('writer and day-math sources are ledger sources', () => {
  for (const s of [...WRITER_SOURCES, ...DAY_MATH_SOURCES, CLOSE_STALE_SOURCE]) {
    assert.ok(LEDGER_SOURCES.has(s), `${s} missing from LEDGER_SOURCES`);
  }
});

test('no root script redefines the source sets or exit codes', () => {
  const owner = 'tracker-utils.mjs';
  const patterns = [
    /new Set\(\[\s*'set-status'/,
    /\bconst\s+EXIT_(OK|USAGE|NOT_FOUND|AMBIGUOUS|LOCK_TIMEOUT|STALE)\s*=\s*\d/,
  ];
  const hits = [];
  for (const f of readdirSync(ROOT).filter(f => f.endsWith('.mjs') && f !== owner)) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const re of patterns) if (re.test(src)) hits.push(`${f}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('followup-seed maps onto the shared numbering', () => {
  const src = readFileSync(join(ROOT, 'followup-seed.mjs'), 'utf8');
  const map = src.match(/const EXIT_CODES = \{([^}]*)\}/)[1];
  assert.doesNotMatch(map, /:\s*\d/, 'EXIT_CODES values must come from CLI_EXIT');
  assert.equal(CLI_EXIT.LOCK_TIMEOUT, 4);
});
