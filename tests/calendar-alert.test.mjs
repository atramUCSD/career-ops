// calendar-alert, offline: which postings earn an event, when the event lands,
// and that a repeat insert is a no-op rather than a duplicate or a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarConfig, eventFor, eventId, insertEvent, selectRows, slotDate } from '../calendar-alert.mjs';

const row = (over = {}) => ({
  u: 'https://jobs.ashbyhq.com/anduril/123', c: 'Anduril Industries', t: 'Senior Frontend Engineer',
  l: 'Costa Mesa, CA', cb: 70, kw: ['Frontend'], all: ['Frontend', 'React'], why: [{ why: 'staff — above target level' }],
  ...over,
});

test('every rule must pass; empty lists are no constraint', () => {
  const cfg = calendarConfig({ calendar: { companies: ['Anduril', 'Meta'], keywords: ['React'] } });
  const rows = [
    row(),
    row({ u: 'https://x.test/1', cb: 64 }),
    row({ u: 'https://www.linkedin.com/jobs/view/1' }),
    row({ u: 'https://x.test/2', c: 'Metabase' }),
    row({ u: 'https://x.test/3', c: 'Meta' }),
    row({ u: 'https://x.test/4', t: 'Maintenance Lead', kw: [], all: [] }),
  ];
  assert.deepEqual(selectRows(rows, cfg).map(r => r.u), ['https://jobs.ashbyhq.com/anduril/123', 'https://x.test/3']);
  assert.equal(selectRows(rows, calendarConfig({})).length, 4, 'defaults keep only the score floor and the LinkedIn exclusion');
});

test('locations: any listed city in a multi-city posting passes; Remote and blank do not', () => {
  const cfg = calendarConfig({ calendar: { locations: ['San Francisco', 'Palo Alto'] } });
  const rows = [
    row({ u: 'https://x.test/sf', l: 'New York, NY; San Francisco, CA' }),
    row({ u: 'https://x.test/ssf', l: 'South San Francisco, CA' }),
    row({ u: 'https://x.test/ny', l: 'New York, NY' }),
    row({ u: 'https://x.test/remote', l: 'Remote - US' }),
    row({ u: 'https://x.test/blank', l: '' }),
  ];
  assert.deepEqual(selectRows(rows, cfg).map(r => r.u), ['https://x.test/sf', 'https://x.test/ssf']);
});

test('the slot is today at the configured time, or tomorrow once it has passed', () => {
  const cfg = calendarConfig({ calendar: { at: '21:00' } });
  // 07:00 and 21:30 Pacific (PDT, UTC-7) on 2026-10-30.
  assert.equal(slotDate(cfg, new Date('2026-10-30T14:00:00Z')), '2026-10-30');
  assert.equal(slotDate(cfg, new Date('2026-10-31T04:30:00Z')), '2026-10-31');
  const e = eventFor(row(), { ...cfg, at: '23:45' }, new Date('2026-10-30T14:00:00Z'));
  assert.equal(e.start.dateTime, '2026-10-30T23:45:00');
  assert.equal(e.end.dateTime, '2026-10-31T00:15:00', 'a slot near midnight ends on the next day');
  assert.equal(e.start.timeZone, 'America/Los_Angeles');
  assert.match(e.description, /ashbyhq\.com[\s\S]*above target level/);
});

test('the event id is stable per URL and inside the Calendar id alphabet', () => {
  assert.equal(eventId('https://a.test/1'), eventId('https://a.test/1'));
  assert.notEqual(eventId('https://a.test/1'), eventId('https://a.test/2'));
  assert.match(eventId('https://a.test/1'), /^[a-v0-9]{5,1024}$/);
});

test('a bad time or zone fails before any event is built', () => {
  assert.throws(() => calendarConfig({ calendar: { at: '9pm' } }), /HH:MM/);
  assert.throws(() => calendarConfig({ calendar: { time_zone: 'Mars/Olympus' } }), RangeError);
});

test('insert: 409 is an existing event, other errors carry the API message', async () => {
  const reply = (status, body = {}) => async () => new Response(JSON.stringify(body), { status });
  const event = eventFor(row(), calendarConfig({}));
  assert.equal(await insertEvent(event, { token: 't', fetchFn: reply(200) }), 'created');
  assert.equal(await insertEvent(event, { token: 't', fetchFn: reply(409) }), 'exists');
  await assert.rejects(
    insertEvent(event, { token: 't', fetchFn: reply(403, { error: { message: 'Calendar API has not been used in project 1' } }) }),
    /403 Calendar API has not been used/,
  );
});
