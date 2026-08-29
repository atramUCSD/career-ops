// tests/provider-francetravail.test.mjs — offline tests for providers/francetravail.mjs.
// Fixtures follow the official OpenAPI spec (francetravail.io api id 84,
// fetched live 2026-08-28/29) — documented-only shapes: the authenticated API
// was never probed live (no credentials in this repo). The token-endpoint
// error shape (400 invalid_client) WAS live-verified; see the provider header.
// Run: node tests/provider-francetravail.test.mjs
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — francetravail');

// Offline guarantee: any code path that reaches the real network fails loudly.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('offline test hit real fetch'); };

// Credentials come from process.env — pin a known state, restore in finally.
const savedId = process.env.FRANCETRAVAIL_CLIENT_ID;
const savedSecret = process.env.FRANCETRAVAIL_CLIENT_SECRET;

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/francetravail.mjs')).href);
  const ft = mod.default;
  const { normalizeOffre, parseFrancetravailConfig, readCredentials } = mod;

  if (ft.id === 'francetravail') pass('francetravail.id is "francetravail"');
  else fail(`francetravail.id is ${JSON.stringify(ft.id)}`);

  // readCredentials — both halves required, trimmed.
  const noCreds = [
    readCredentials({}),
    readCredentials({ FRANCETRAVAIL_CLIENT_ID: 'PAR_x' }),
    readCredentials({ FRANCETRAVAIL_CLIENT_SECRET: 's' }),
    readCredentials({ FRANCETRAVAIL_CLIENT_ID: '  ', FRANCETRAVAIL_CLIENT_SECRET: 's' }),
  ];
  const okCreds = readCredentials({ FRANCETRAVAIL_CLIENT_ID: ' PAR_x ', FRANCETRAVAIL_CLIENT_SECRET: ' sec ' });
  if (noCreds.every(c => c === null) && okCreds && okCreds.clientId === 'PAR_x' && okCreds.clientSecret === 'sec') {
    pass('readCredentials requires both halves and trims them');
  } else {
    fail(`readCredentials = ${JSON.stringify({ noCreds, okCreds })}`);
  }

  // parseFrancetravailConfig — defaults and clamps.
  const defaults = parseFrancetravailConfig({});
  if (defaults.keywords.length === 0 && defaults.days === 30 && defaults.size === 150
      && defaults.commune === '' && defaults.departement === '' && defaults.distance === 10) {
    pass('parseFrancetravailConfig defaults: days 30, size 150, distance 10, no location');
  } else {
    fail(`parseFrancetravailConfig defaults = ${JSON.stringify(defaults)}`);
  }
  const clamped = parseFrancetravailConfig({ francetravail: { keywords: [' ml ', '', 7], days: 999, size: 0, distance: -3 } });
  if (clamped.keywords.length === 1 && clamped.keywords[0] === 'ml' && clamped.days === 31 && clamped.size === 1 && clamped.distance === 0) {
    pass('parseFrancetravailConfig clamps days<=31 / size>=1 / distance>=0 and cleans keywords');
  } else {
    fail(`parseFrancetravailConfig clamped = ${JSON.stringify(clamped)}`);
  }

  // normalizeOffre — documented Offre shape (OpenAPI spec, documented-only).
  const full = normalizeOffre({
    id: '184XYZQ',
    intitule: '  Développeur IA (H/F)  ',
    description: '  Mission de développement de modèles.  ',
    dateCreation: '2026-08-20T08:15:00.000Z',
    lieuTravail: { libelle: '75 - PARIS 01', codePostal: '75001', commune: '75101' },
    entreprise: { nom: '  ACME SAS  ' },
    typeContrat: 'CDI',
    origineOffre: { origine: '2', urlOrigine: 'https://partner.example/jobs/184XYZQ' },
  });
  if (full && full.title === 'Développeur IA (H/F)' && full.url === 'https://partner.example/jobs/184XYZQ'
      && full.company === 'ACME SAS' && full.location === '75 - PARIS 01'
      && full.description === 'Mission de développement de modèles.'
      && full.postedAt === Date.parse('2026-08-20T08:15:00.000Z') && full.id === '184XYZQ') {
    pass('normalizeOffre maps + trims intitule/urlOrigine/entreprise.nom/lieuTravail.libelle/description and parses dateCreation');
  } else {
    fail(`normalizeOffre full = ${JSON.stringify(full)}`);
  }

  // No (or non-https) urlOrigine → France Travail candidate page fallback.
  const noUrl = normalizeOffre({ id: '999AAAB', intitule: 'T' });
  const badUrl = normalizeOffre({ id: '999AAAC', intitule: 'T', origineOffre: { urlOrigine: 'http://insecure.example/x' } });
  if (noUrl?.url === 'https://candidat.francetravail.fr/offres/recherche/detail/999AAAB'
      && badUrl?.url === 'https://candidat.francetravail.fr/offres/recherche/detail/999AAAC') {
    pass('normalizeOffre falls back to the candidat.francetravail.fr detail page (https urlOrigine only)');
  } else {
    fail(`normalizeOffre url fallback = ${JSON.stringify({ noUrl: noUrl?.url, badUrl: badUrl?.url })}`);
  }

  // Drops: missing id, empty title, non-object.
  const drops = [normalizeOffre({ intitule: 'No id' }), normalizeOffre({ id: 'X', intitule: '  ' }), normalizeOffre(null)];
  if (drops.every(r => r === null)) pass('normalizeOffre drops missing-id / empty-title / non-object');
  else fail(`normalizeOffre drops = ${JSON.stringify(drops)}`);

  // Optional fields omitted when absent.
  const bare = normalizeOffre({ id: 'Y1', intitule: 'T' });
  if (bare && !('description' in bare) && !('postedAt' in bare) && bare.company === '' && bare.location === '') {
    pass('normalizeOffre omits description/postedAt when absent, empty company/location');
  } else {
    fail(`normalizeOffre bare = ${JSON.stringify(bare)}`);
  }

  // ── fetch(): credentials absent → one warning + empty result, zero network ──
  delete process.env.FRANCETRAVAIL_CLIENT_ID;
  delete process.env.FRANCETRAVAIL_CLIENT_SECRET;
  let networkCalls = 0;
  const countingCtx = {
    fetchJson: async () => { networkCalls++; return {}; },
    fetchResponse: async () => { networkCalls++; return new Response(null, { status: 204 }); },
  };
  const noCredsJobs = await ft.fetch({ name: 'FT', francetravail: { keywords: ['ml'] } }, countingCtx);
  if (Array.isArray(noCredsJobs) && noCredsJobs.length === 0 && networkCalls === 0) {
    pass('fetch() without credentials returns [] and never touches the network');
  } else {
    fail(`fetch() without credentials = ${JSON.stringify(noCredsJobs)}, networkCalls=${networkCalls}`);
  }

  // Misconfiguration still throws (repo contract), even without credentials.
  let noKwThrew = false;
  try { await ft.fetch({ name: 'FT' }, countingCtx); } catch (e) { noKwThrew = /keywords/.test(e.message); }
  if (noKwThrew) pass('fetch() throws on a missing francetravail.keywords[] block');
  else fail('fetch() should throw when keywords[] is absent');

  // ── with credentials from here on ──
  process.env.FRANCETRAVAIL_CLIENT_ID = 'PAR_testclient';
  process.env.FRANCETRAVAIL_CLIENT_SECRET = 'testsecret';

  // Fixture per the documented ResultatRecherche shape.
  const mkOffre = (i, extra = {}) => ({
    id: `184AAA${i}`,
    intitule: `Data Engineer ${i} (H/F)`,
    description: 'Description complète.',
    dateCreation: '2026-08-20T08:15:00.000Z',
    lieuTravail: { libelle: '69 - LYON 03' },
    entreprise: { nom: `Entreprise ${i}` },
    typeContrat: 'CDI',
    origineOffre: { origine: '1', urlOrigine: `https://candidat.francetravail.fr/offres/recherche/detail/184AAA${i}` },
    ...extra,
  });

  // Happy path: token POST + one search GET per keyword, dedup across keywords.
  const tokenCalls = [];
  const searchCalls = [];
  const happyCtx = {
    fetchJson: async (url, opts) => {
      tokenCalls.push({ url, opts });
      return { access_token: 'tok-123', token_type: 'Bearer', expires_in: 1499, scope: 'api_offresdemploiv2 o2dsoffre' };
    },
    fetchResponse: async (url, opts) => {
      searchCalls.push({ url, opts });
      const kw = new URL(url).searchParams.get('motsCles');
      const body = kw === 'python'
        ? { resultats: [mkOffre(1), mkOffre(3)], filtresPossibles: [] }   // 1 duplicates the first keyword's
        : { resultats: [mkOffre(1), mkOffre(2), { intitule: 'no id' }], filtresPossibles: [] };
      return new Response(JSON.stringify(body), { status: 206 }); // 206 = partial content, still valid
    },
  };
  const jobs = await ft.fetch(
    { name: 'FT', francetravail: { keywords: ['data engineer', 'python'], commune: '69383', distance: 30, days: 14, size: 50 } },
    happyCtx,
  );

  const tokenBody = tokenCalls[0] && new URLSearchParams(tokenCalls[0].opts.body);
  if (tokenCalls.length === 1
      && tokenCalls[0].url === 'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire'
      && tokenCalls[0].opts.method === 'POST'
      && tokenCalls[0].opts.redirect === 'error'
      && tokenBody.get('grant_type') === 'client_credentials'
      && tokenBody.get('client_id') === 'PAR_testclient'
      && tokenBody.get('scope') === 'api_offresdemploiv2 o2dsoffre') {
    pass('fetch() POSTs the OAuth2 client-credentials form to the realm=/partenaire token URL once');
  } else {
    fail(`token calls = ${JSON.stringify(tokenCalls.map(c => ({ url: c.url, body: c.opts?.body })))}`);
  }

  const u0 = searchCalls[0] && new URL(searchCalls[0].url);
  if (searchCalls.length === 2
      && u0.origin + u0.pathname === 'https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search'
      && u0.searchParams.get('motsCles') === 'data engineer'
      && u0.searchParams.get('publieeDepuis') === '14'
      && u0.searchParams.get('range') === '0-49'
      && u0.searchParams.get('commune') === '69383'
      && u0.searchParams.get('distance') === '30'
      && searchCalls.every(c => c.opts.headers.authorization === 'Bearer tok-123' && c.opts.redirect === 'error')) {
    pass('fetch() GETs /v2/offres/search per keyword with Bearer token, range/publieeDepuis/commune params, redirect:"error"');
  } else {
    fail(`search calls = ${JSON.stringify(searchCalls.map(c => c.url))}`);
  }

  if (jobs.length === 3 && jobs.every(j => !('id' in j))
      && jobs[0].title === 'Data Engineer 1 (H/F)' && jobs[0].company === 'Entreprise 1'
      && jobs[0].location === '69 - LYON 03'
      && jobs[0].url === 'https://candidat.francetravail.fr/offres/recherche/detail/184AAA1') {
    pass('fetch() aggregates + dedups by offer id across keywords, drops id-less rows, strips the internal id');
  } else {
    fail(`fetch() happy path jobs = ${JSON.stringify(jobs)}`);
  }

  // Empty result: documented 204 No Content (empty body) → [].
  const emptyCtx = {
    fetchJson: async () => ({ access_token: 'tok', token_type: 'Bearer' }),
    fetchResponse: async () => new Response(null, { status: 204 }),
  };
  const empty = await ft.fetch({ name: 'FT', francetravail: { keywords: ['cobol'] } }, emptyCtx);
  if (Array.isArray(empty) && empty.length === 0) pass('fetch() maps the documented 204 no-matching-offer response to []');
  else fail(`fetch() 204 = ${JSON.stringify(empty)}`);

  // Malformed payload: 200 without resultats[] must throw, never look empty.
  let malformedThrew = false;
  try {
    await ft.fetch({ name: 'FT', francetravail: { keywords: ['x y'] } }, {
      fetchJson: async () => ({ access_token: 'tok' }),
      fetchResponse: async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    });
  } catch (e) {
    malformedThrew = /unexpected API response/.test(e.message);
  }
  if (malformedThrew) pass('fetch() throws on a payload without resultats[] (never masquerades as an empty board)');
  else fail('fetch() should throw on a malformed search payload');

  // HTTP error on every keyword → throws; on one of two keywords → tolerated.
  const httpErr = () => { const e = new Error('HTTP 500 Internal Server Error'); e.status = 500; throw e; };
  let outageThrew = false;
  try {
    await ft.fetch({ name: 'FT', francetravail: { keywords: ['a b'] } }, {
      fetchJson: async () => ({ access_token: 'tok' }),
      fetchResponse: async () => httpErr(),
    });
  } catch (e) {
    outageThrew = /all 1 keyword request\(s\) failed/.test(e.message) && /HTTP 500/.test(e.message);
  }
  if (outageThrew) pass('fetch() throws when every keyword request fails (total outage)');
  else fail('fetch() should throw on a total search outage');

  const partial = await ft.fetch({ name: 'FT', francetravail: { keywords: ['good', 'bad'] } }, {
    fetchJson: async () => ({ access_token: 'tok' }),
    fetchResponse: async (url) => {
      if (new URL(url).searchParams.get('motsCles') === 'bad') httpErr();
      return new Response(JSON.stringify({ resultats: [mkOffre(9)] }), { status: 200 });
    },
  });
  if (partial.length === 1 && partial[0].title === 'Data Engineer 9 (H/F)') {
    pass('fetch() tolerates a single failed keyword and keeps the surviving results');
  } else {
    fail(`fetch() partial outage = ${JSON.stringify(partial)}`);
  }

  // Token failures: HTTP error and missing access_token both throw clearly.
  let tokenHttpThrew = false;
  try {
    await ft.fetch({ name: 'FT', francetravail: { keywords: ['x y'] } }, {
      fetchJson: async () => { const e = new Error('HTTP 400 Bad Request'); e.status = 400; e.body = '{"error":"invalid_client","error_description":"Client authentication failed"}'; throw e; },
      fetchResponse: async () => fail('search must not run after a failed token request'),
    });
  } catch (e) {
    tokenHttpThrew = /token request failed/.test(e.message) && /HTTP 400/.test(e.message);
  }
  if (tokenHttpThrew) pass('fetch() throws (does not half-fetch) when the token endpoint rejects the credentials');
  else fail('fetch() should throw on a token HTTP error');

  let tokenShapeThrew = false;
  try {
    await ft.fetch({ name: 'FT', francetravail: { keywords: ['x y'] } }, {
      fetchJson: async () => ({ nope: true }),
      fetchResponse: async () => fail('search must not run without an access token'),
    });
  } catch (e) {
    tokenShapeThrew = /no access_token/.test(e.message);
  }
  if (tokenShapeThrew) pass('fetch() throws when the token response carries no access_token');
  else fail('fetch() should throw on a malformed token payload');

} catch (e) {
  fail(`francetravail provider tests crashed: ${e.message}`);
} finally {
  globalThis.fetch = realFetch;
  if (savedId === undefined) delete process.env.FRANCETRAVAIL_CLIENT_ID;
  else process.env.FRANCETRAVAIL_CLIENT_ID = savedId;
  if (savedSecret === undefined) delete process.env.FRANCETRAVAIL_CLIENT_SECRET;
  else process.env.FRANCETRAVAIL_CLIENT_SECRET = savedSecret;
}
