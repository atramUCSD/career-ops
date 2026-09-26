// tests/hydration-state.test.mjs — which hydration is the reader being served?
//
// The artifact is a static file. Nothing in it is fetched when the page opens,
// so the build stamp is the reader's only evidence that the numbers are
// current, and this branch is what turns that stamp into an answer. It is
// worth pinning because both wrong answers are quiet: calling a missed run
// "live" tells someone stale data is fresh, and calling a fresh build "stale"
// trains them to ignore the indicator entirely.
//
// Windows are 07:00 and 19:00 local — the scheduled task's `/ri 720 /du 24:00`.
import { pass, fail } from './helpers.mjs';
import { hydrationState } from '../build-artifact.mjs';

console.log('\nhydration state — green, red and grey as the reader sees them');

/** Local wall-clock, because the hydration windows are local hours. */
const at = (d, h, m = 0) => new Date(2026, 7, d, h, m, 0);
const iso = (d, h, m = 0) => at(d, h, m).toISOString();

const cases = [
  ['live', iso(20, 7, 2), at(20, 9), 'a 07:02 build read at 09:00 is this morning\'s hydration'],
  ['live', iso(20, 19, 1), at(20, 23), 'an evening build read the same evening is current'],
  ['live', iso(20, 19, 30), at(21, 3), 'read after midnight, the 19:00 build is still the current window'],
  ['missed', iso(20, 7, 2), at(20, 20), 'the 19:00 window opened and produced nothing'],
  ['missed', iso(19, 19, 5), at(20, 8), 'last night ran, this morning did not'],
  ['stale', iso(19, 7, 0), at(20, 9), 'two windows back is no longer a missed run, just old'],
  ['stale', iso(1, 12, 0), at(20, 9), 'weeks old'],
  ['missed', null, at(20, 9), 'a page with no build stamp cannot claim to be fresh'],
  ['missed', 'not a date', at(20, 9), 'an unparseable stamp is treated as a failure, not as fresh'],
];

for (const [want, built, now, why] of cases) {
  const got = hydrationState(built, now);
  got === want ? pass(`${want}: ${why}`) : fail(`${why} — wanted ${want}, got ${got}`);
}

// The boundary itself: a build one minute before its own window belongs to the
// previous one. Off by one here is the difference between red and green.
hydrationState(iso(20, 6, 59), at(20, 7, 30)) === 'missed'
  ? pass('a build one minute before the window it was meant to fill does not count as that window')
  : fail('the window boundary is inclusive in the wrong direction');

hydrationState(iso(20, 9, 0), at(20, 9, 5)) === 'live'
  ? pass('a manual rebuild between windows reads as live')
  : fail('a fresh manual rebuild was not reported as live');
