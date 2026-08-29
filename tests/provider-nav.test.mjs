// tests/provider-nav.test.mjs — NAV pam-stilling-feed provider (Norway).
// Fixtures mirror the shapes live-probed on 2026-08-29 (see providers/nav.mjs
// header): the /api/publicToken plain-text body, and the JSON-Feed pages whose
// items carry `_feed_entry: {uuid, status, title, businessName, municipal}`.
// Offline by construction: the provider is driven through a fake ctx, and
// globalThis.fetch is stubbed to throw so an accidental real request fails fast.
import { pass, fail } from './helpers.mjs';
import nav, { extractPublicToken, parseNavConfig, normalizeItem } from '../providers/nav.mjs';

console.log('\nProvider — nav (pam-stilling-feed)');

const FEED_URL = 'https://pam-stilling-feed.nav.no/api/v1/feed';
const TOKEN_URL = 'https://pam-stilling-feed.nav.no/api/publicToken';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.c2ln';
const TOKEN_BODY = `Current public token for Nav Job Vacancy Feed:\n${JWT}`;

/** One feed item (change event) in the probed shape. */
const item = (uuid, status, title, businessName = 'Co AS', municipal = 'OSLO', extra = {}) => ({
  id: uuid,
  url: `/api/v1/feedentry/${uuid}`,
  title,
  content_text: 'Stillingsannonse',
  date_modified: '2026-08-28T09:52:32.29277+02:00',
  _feed_entry: { uuid, status, title, businessName, municipal, sistEndret: '2026-08-28T09:52:32.29277+02:00' },
  ...extra,
});

/** A feed page in the probed shape. */
const feedPage = (id, next_id, ...items) => ({
  version: '1.0',
  title: 'Stillingsfeeden fra arbeidsplassen.no',
  home_page_url: 'https://arbeidsplassen.nav.no',
  feed_url: `/api/v1/feed/${id}`,
  description: 'Feed med stillinger fra arbeidsplassen.no',
  next_url: next_id ? `/api/v1/feed/${next_id}` : null,
  id,
  next_id: next_id || null,
  items,
});

/** Fake ctx: token from fetchText, pages routed by URL; records every request. */
const mkCtx = (pagesByUrl, { tokenBody = TOKEN_BODY } = {}) => {
  const calls = [];
  return {
    calls,
    transport: 'http',
    fetchText: async (url, opts) => {
      calls.push({ kind: 'text', url, opts });
      return tokenBody;
    },
    fetchJson: async (url, opts) => {
      calls.push({ kind: 'json', url, opts });
      const hit = pagesByUrl[url];
      if (!hit) { const e = new Error('HTTP 404'); e.status = 404; throw e; }
      if (typeof hit === 'function') return hit();
      return hit;
    },
    sleep: async () => {},
  };
};

const httpErr = (status, msg = `HTTP ${status}`) => () => { const e = new Error(msg); e.status = status; throw e; };

const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('offline test made a real network request'); };
try {
  if (nav.id === 'nav') pass('nav.id is "nav"');
  else fail(`nav.id is ${JSON.stringify(nav.id)}`);

  // extractPublicToken — the probed plain-text body, and garbage.
  if (extractPublicToken(TOKEN_BODY) === JWT) pass('extractPublicToken pulls the JWT out of the plain-text body');
  else fail(`extractPublicToken = ${JSON.stringify(extractPublicToken(TOKEN_BODY))}`);
  if (extractPublicToken('no token here') === '' && extractPublicToken(null) === '') {
    pass('extractPublicToken returns "" for tokenless/garbage input');
  } else {
    fail('extractPublicToken should return "" for tokenless/garbage input');
  }

  // parseNavConfig — defaults and clamping.
  const def = parseNavConfig({});
  if (def.days === 2 && def.maxPages === 10) pass('parseNavConfig applies defaults (days 2, maxPages 10)');
  else fail(`parseNavConfig defaults = ${JSON.stringify(def)}`);
  const clamped = parseNavConfig({ nav: { days: 9999, maxPages: 0 } });
  if (clamped.days === 30 && clamped.maxPages === 1) pass('parseNavConfig clamps days/maxPages');
  else fail(`parseNavConfig clamped = ${JSON.stringify(clamped)}`);

  // normalizeItem — happy path builds the arbeidsplassen.no ad URL.
  const norm = normalizeItem(item('7f202e42-df97-439c-a434-40987beacffc', 'ACTIVE', ' BPA-assistent ', ' Medvind AS ', ' SENJA '));
  if (norm && norm.title === 'BPA-assistent' && norm.company === 'Medvind AS' && norm.location === 'SENJA'
      && norm.url === 'https://arbeidsplassen.nav.no/stillinger/stilling/7f202e42-df97-439c-a434-40987beacffc'
      && norm.status === 'ACTIVE' && typeof norm.postedAt === 'number') {
    pass('normalizeItem trims fields, builds the public ad URL, parses date_modified');
  } else {
    fail(`normalizeItem = ${JSON.stringify(norm)}`);
  }
  if (normalizeItem({ _feed_entry: { status: 'ACTIVE', title: 'No uuid' } }) === null) {
    pass('normalizeItem returns null without a uuid');
  } else {
    fail('normalizeItem should return null without a uuid');
  }
  // A titleless event is KEPT (title '') — dropping it would revive the
  // earlier ACTIVE event for the same uuid in the dedup map.
  const titleless = normalizeItem({ id: 'x', _feed_entry: { uuid: 'x', status: 'INACTIVE', title: '' } });
  if (titleless && titleless.uuid === 'x' && titleless.title === '' && titleless.status === 'INACTIVE') {
    pass('normalizeItem keeps a titleless event (deactivations must supersede)');
  } else {
    fail(`normalizeItem titleless = ${JSON.stringify(titleless)}`);
  }

  // fetch() — happy path: two pages, ACTIVE-only, last event per uuid wins.
  // Page 1: A ACTIVE, B ACTIVE, C INACTIVE (anonymized). Page 2: A INACTIVE
  // (deactivated after posting) — so only B survives.
  const p2Url = 'https://pam-stilling-feed.nav.no/api/v1/feed/22222222-2222-4222-8222-222222222222';
  const ctx1 = mkCtx({
    [FEED_URL]: feedPage('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
      item('aaaa', 'ACTIVE', 'Sykepleier', 'Oslo Kommune', 'OSLO'),
      item('bbbb', 'ACTIVE', 'Utvikler', 'Firma AS', 'BERGEN'),
      item('cccc', 'INACTIVE', '...', '', 'NARVIK')),
    [p2Url]: feedPage('22222222-2222-4222-8222-222222222222', null,
      item('aaaa', 'INACTIVE', 'Sykepleier', 'Oslo Kommune', 'OSLO')),
  });
  const jobs = await nav.fetch({ name: 'NAV' }, ctx1);
  if (jobs.length === 1 && jobs[0].title === 'Utvikler' && jobs[0].company === 'Firma AS'
      && jobs[0].location === 'BERGEN'
      && jobs[0].url === 'https://arbeidsplassen.nav.no/stillinger/stilling/bbbb'
      && !('status' in jobs[0]) && !('uuid' in jobs[0])) {
    pass('nav.fetch() keeps only ads whose LAST event is ACTIVE and strips uuid/status');
  } else {
    fail(`nav.fetch() = ${JSON.stringify(jobs)}`);
  }
  const tokenCall = ctx1.calls.find(c => c.kind === 'text');
  const firstFeed = ctx1.calls.find(c => c.kind === 'json');
  const secondFeed = ctx1.calls.filter(c => c.kind === 'json')[1];
  if (tokenCall && tokenCall.url === TOKEN_URL && tokenCall.opts?.redirect === 'error') {
    pass('nav.fetch() fetches the rotating token from /api/publicToken with redirect:"error"');
  } else {
    fail(`nav.fetch() token call = ${JSON.stringify(tokenCall)}`);
  }
  if (firstFeed && firstFeed.url === FEED_URL
      && firstFeed.opts?.headers?.authorization === `Bearer ${JWT}`
      && /^\w{3}, \d{2} \w{3} \d{4}/.test(firstFeed.opts?.headers?.['if-modified-since'] || '')
      && firstFeed.opts?.redirect === 'error') {
    pass('nav.fetch() sends Bearer token + RFC1123 If-Modified-Since on the feed request');
  } else {
    fail(`nav.fetch() first feed call = ${JSON.stringify(firstFeed)}`);
  }
  if (secondFeed && secondFeed.url === p2Url && !('if-modified-since' in (secondFeed.opts?.headers || {}))) {
    pass('nav.fetch() follows next_url resolved against the feed origin, without If-Modified-Since');
  } else {
    fail(`nav.fetch() second feed call = ${JSON.stringify(secondFeed)}`);
  }

  // fetch() — regression: a titleless INACTIVE event must still supersede the
  // earlier ACTIVE event for the same uuid (page 1 ACTIVE, page 2 INACTIVE '').
  const dead = await nav.fetch({ name: 'NAV' }, mkCtx({
    [FEED_URL]: feedPage('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
      item('dddd', 'ACTIVE', 'Utvikler', 'Firma AS', 'BERGEN')),
    [p2Url]: feedPage('22222222-2222-4222-8222-222222222222', null,
      item('dddd', 'INACTIVE', '', '', '')),
  }));
  if (Array.isArray(dead) && dead.length === 0) {
    pass('nav.fetch() lets a titleless INACTIVE event supersede an earlier ACTIVE one');
  } else {
    fail(`nav.fetch() returned a deactivated ad: ${JSON.stringify(dead)}`);
  }

  // fetch() — 404/304 on the first feed request = quiet feed, NOT an outage.
  for (const status of [404, 304]) {
    const empty = await nav.fetch({ name: 'NAV' }, mkCtx({ [FEED_URL]: httpErr(status) }));
    if (Array.isArray(empty) && empty.length === 0) pass(`nav.fetch() returns [] on HTTP ${status} (nothing newer than the cutoff)`);
    else fail(`nav.fetch() HTTP ${status} = ${JSON.stringify(empty)}`);
  }

  // fetch() — malformed first page must throw, never masquerade as empty.
  let badThrew = false;
  try {
    await nav.fetch({ name: 'NAV' }, mkCtx({ [FEED_URL]: { wrong: true } }));
  } catch (e) { badThrew = /unexpected API response shape/.test(e.message); }
  if (badThrew) pass('nav.fetch() throws on a malformed first page (no items[])');
  else fail('nav.fetch() should throw when the first page has no items[]');

  // fetch() — HTTP error on the first feed request propagates (total outage).
  let outageThrew = false;
  try {
    await nav.fetch({ name: 'NAV' }, mkCtx({ [FEED_URL]: httpErr(503) }));
  } catch (e) { outageThrew = /503/.test(e.message); }
  if (outageThrew) pass('nav.fetch() throws on HTTP 503 (outage is not an empty board)');
  else fail('nav.fetch() should rethrow a non-404/304 HTTP error');

  // fetch() — token endpoint without a JWT in the body must throw.
  let tokenThrew = false;
  try {
    await nav.fetch({ name: 'NAV' }, mkCtx({}, { tokenBody: 'maintenance page' }));
  } catch (e) { tokenThrew = /no public token/.test(e.message); }
  if (tokenThrew) pass('nav.fetch() throws when /api/publicToken yields no JWT');
  else fail('nav.fetch() should throw when the token body has no JWT');

  // fetch() — a page-walk failure keeps what earlier pages yielded.
  const partial = await nav.fetch({ name: 'NAV' }, mkCtx({
    [FEED_URL]: feedPage('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
      item('aaaa', 'ACTIVE', 'Sykepleier')),
    [p2Url]: httpErr(503),
  }));
  if (partial.length === 1 && partial[0].title === 'Sykepleier') {
    pass('nav.fetch() keeps page-1 results when a later page fails');
  } else {
    fail(`nav.fetch() partial = ${JSON.stringify(partial)}`);
  }

  // fetch() — ctx.maxPages hint (health probe passes 1) stops the walk.
  const ctxCap = mkCtx({
    [FEED_URL]: feedPage('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
      item('aaaa', 'ACTIVE', 'Sykepleier')),
  });
  ctxCap.maxPages = 1;
  const capped = await nav.fetch({ name: 'NAV' }, ctxCap);
  if (capped.length === 1 && ctxCap.calls.filter(c => c.kind === 'json').length === 1) {
    pass('nav.fetch() honors ctx.maxPages (single page request)');
  } else {
    fail(`nav.fetch() ctx.maxPages=1 made ${ctxCap.calls.filter(c => c.kind === 'json').length} page requests`);
  }

  // fetch() — a next_url pointing off the feed origin is refused.
  const ctxEvil = mkCtx({
    [FEED_URL]: {
      ...feedPage('11111111-1111-4111-8111-111111111111', null, item('aaaa', 'ACTIVE', 'Sykepleier')),
      next_url: 'https://evil.example.com/api/v1/feed/x',
    },
  });
  const evil = await nav.fetch({ name: 'NAV' }, ctxEvil);
  if (evil.length === 1 && ctxEvil.calls.filter(c => c.kind === 'json').length === 1) {
    pass('nav.fetch() refuses a next_url that leaves the feed origin');
  } else {
    fail('nav.fetch() followed a cross-origin next_url');
  }

} catch (e) {
  fail(`nav provider tests crashed: ${e.message}`);
} finally {
  globalThis.fetch = realFetch;
}
