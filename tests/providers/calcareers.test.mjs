// tests/providers/calcareers.test.mjs — offline unit tests for
// providers/calcareers.mjs. Fixtures are trimmed copies of the live WebForms
// markup probed 2026-10-04 (hidden inputs, the lblTotalResultCount badge, the
// "No jobs found" alert, result cards). No network: the provider only talks
// through ctx.fetchResponse, stubbed here with a scripted postback sequence.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — calcareers');

const hidden = (vs) => `<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="${vs}" />
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="ev&amp;1" />`;
const card = (i, id, cls, working, extra = '') => `<div id="cphMainContent_rptResults_pnlCardContainer_${i}" class="card card-default">
<a id="cphMainContent_rptResults_hlViewJobPosting_${i}" class="lead visitedLink" aria-label="${cls} (${id})" href="https://www.calcareers.ca.gov/CalHrPublic/Jobs/JobPosting.aspx?JobControlId=${id}">${cls}</a>
<div class="col-xs-6 job-label">Working Title:</div> <div class="col-xs-6 job-details"> <span title="Keyword Relevance: 128">${working}</span> </div>
<div class="col-xs-6 job-label">Job Control:</div> <div class="col-xs-6 job-details">${id}</div>
<div class="col-xs-6 job-label">Salary Range:</div> <div class="col-xs-6 job-details">$6513.00 - $10537.00</div>
<div class="col-xs-6 job-label">Work Type/Schedule:</div> <div class="col-xs-6 job-details">Permanent Fulltime</div>
<div class="col-xs-6 job-label">Department:</div> <div class="col-xs-6 job-details">Department of Social Services</div>
<div class="col-xs-6 job-label">Location:</div> <div class="col-xs-6 job-details">Sacramento County</div>
<div class="col-xs-6 job-label">Telework:</div> <div class="col-xs-6 job-details">Hybrid</div>
<div class="col-xs-6 job-label">Publish Date:</div> <div class="col-xs-6 job-details">10/2/2026</div>${extra}
</div>`;
const results = (vs, total, cards) => `${hidden(vs)}<span class="badge">
  <span id="cphMainContent_lblTotalResultCount" class="ecos-result-count number-counter">${total}</span></span>&nbsp;job(s) found.
${cards.join('\n')}`;
const noResults = (vs) => `${hidden(vs)}<div class="alert alert-danger"><strong>No jobs found</strong>
  matching your search criteria.</div>`;

/** Scripted ctx: each call shifts the next page off `pages` and records the request. */
function scripted(pages) {
  const calls = [];
  return {
    calls,
    ctx: {
      fetchResponse: async (url, opts) => {
        calls.push({ url, method: opts.method, form: opts.body ? new URLSearchParams(opts.body) : null, cookie: opts.headers && opts.headers.cookie });
        const next = pages.shift();
        if (next instanceof Error) throw next;
        const headers = new Headers();
        if (calls.length === 1) headers.append('set-cookie', 'ASP.NET_SessionId=abc; path=/; HttpOnly');
        return new Response(next, { status: 200, headers });
      },
    },
  };
}

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/calcareers.mjs')).href);
  const cc = mod.default;
  const { hiddenFields, resultCount, parseCards } = mod;

  if (cc.id === 'calcareers') pass('calcareers.id is "calcareers"');
  else fail(`calcareers.id is ${JSON.stringify(cc.id)}`);

  const hf = hiddenFields(hidden('VS1'));
  if (hf.get('__VIEWSTATE') === 'VS1' && hf.get('__EVENTVALIDATION') === 'ev&1') pass('hiddenFields reads and decodes hidden inputs');
  else fail(`hiddenFields = ${hf.toString()}`);

  if (resultCount(results('x', '1,234', [])) === 1234 && resultCount(noResults('x')) === 0 && resultCount('<html></html>') === null) {
    pass('resultCount reads the badge, the no-match alert, and null for neither');
  } else {
    fail('resultCount misread a marker');
  }

  const [job] = parseCards(results('x', 1, [card(0, '533752', 'INFORMATION TECHNOLOGY SPECIALIST I', 'ASP.NET Web Developer')]));
  if (job && job.title === 'ASP.NET Web Developer'
      && job.url === 'https://www.calcareers.ca.gov/CalHrPublic/Jobs/JobPosting.aspx?JobControlId=533752'
      && job.company === 'Department of Social Services'
      && job.location === 'Sacramento County, California (Hybrid)'
      && job.description === 'Classification: INFORMATION TECHNOLOGY SPECIALIST I · $6513.00 - $10537.00/mo · Permanent Fulltime'
      && job.postedAt === Date.UTC(2026, 9, 2)) {
    pass('parseCards maps working title, URL, department, county + state, date');
  } else {
    fail(`parseCards = ${JSON.stringify(job)}`);
  }
  if (parseCards(card(0, 'abc', 'X', 'Y')).length === 0) pass('parseCards drops a card with a non-numeric Job Control');
  else fail('parseCards kept a non-numeric Job Control');

  // fetch — ≤10 hits: GET + one search postback, session cookie carried,
  // keyword and hidden fields posted; zero-hit keyword is [] not an error.
  const small = scripted([hidden('G'), results('S1', 2, [card(0, '1', 'A', 'Web Developer'), card(1, '2', 'B', 'UX Designer')]), noResults('S2')]);
  const got = await cc.fetch({ name: 'C', calcareers: { keywords: ['web developer', 'zzqxvy'] } }, small.ctx);
  const [g, s1, s2] = small.calls;
  if (got.length === 2 && small.calls.length === 3 && g.method === 'GET'
      && s1.method === 'POST' && s1.form.get('__VIEWSTATE') === 'G' && s1.form.get('ctl00$cphMainContent$txtKeyword') === 'web developer'
      && s1.form.get('ctl00$cphMainContent$btnUpdateResults') === 'Search' && s1.cookie === 'ASP.NET_SessionId=abc'
      && s2.form.get('__VIEWSTATE') === 'S1') {
    pass('calcareers.fetch() chains postbacks off the previous page and carries the session cookie');
  } else {
    fail(`calcareers.fetch() small calls = ${JSON.stringify(small.calls.map(c => [c.method, c.form && c.form.get('__VIEWSTATE'), c.cookie]))}, jobs = ${got.length}`);
  }

  // fetch — >100 hits: row-count postback, then sort-by-date postback
  const big = scripted([hidden('G'), results('S', 500, [card(0, '1', 'A', 'T')]), results('R', 500, [card(0, '1', 'A', 'T')]), results('D', 500, [card(0, '9', 'A', 'Newest')])]);
  const bigJobs = await cc.fetch({ name: 'C', calcareers: { keywords: ['information technology'] } }, big.ctx);
  const [, , rc, sort] = big.calls;
  if (big.calls.length === 4
      && rc.form.get('__EVENTTARGET') === 'ctl00$cphMainContent$ddlRowCount' && rc.form.get('ctl00$cphMainContent$ddlRowCount') === '100' && rc.form.get('__VIEWSTATE') === 'S'
      && sort.form.get('__EVENTTARGET') === 'ctl00$cphMainContent$ddlSortBy' && sort.form.get('ctl00$cphMainContent$ddlSortBy') === 'PublishDate DESC' && sort.form.get('__VIEWSTATE') === 'R'
      && bigJobs.length === 1 && bigJobs[0].title === 'Newest') {
    pass('calcareers.fetch() widens to 100 rows then sorts newest-first when the count exceeds 100');
  } else {
    fail(`calcareers.fetch() big calls = ${big.calls.length}, jobs = ${JSON.stringify(bigJobs)}`);
  }

  // fetch — markup change (no count marker) on every keyword throws
  let markupErr = '';
  try {
    await cc.fetch({ name: 'C', calcareers: { keywords: ['x'] } }, scripted([hidden('G'), '<html>redesigned</html>', hidden('G2')]).ctx);
  } catch (err) { markupErr = err.message; }
  if (markupErr.includes('all 1 keyword request(s) failed') && markupErr.includes('markup changed')) pass('calcareers.fetch() throws when no keyword yields a count marker');
  else fail(`calcareers.fetch() markup error = ${JSON.stringify(markupErr) || 'did not throw'}`);

  // fetch — one keyword fails, the next succeeds off a fresh session form
  const partial = scripted([hidden('G'), new Error('HTTP 500'), hidden('G2'), results('S', 1, [card(0, '3', 'A', 'Web Designer')])]);
  const partialJobs = await cc.fetch({ name: 'C', calcareers: { keywords: ['bad', 'good'] } }, partial.ctx);
  if (partialJobs.length === 1 && partial.calls[2].method === 'GET' && partial.calls[3].form.get('__VIEWSTATE') === 'G2') {
    pass('calcareers.fetch() restarts the form after a failed postback and keeps later results');
  } else {
    fail(`calcareers.fetch() partial = ${JSON.stringify(partialJobs)}`);
  }
} catch (e) {
  fail(`calcareers provider tests crashed: ${e.message}`);
}
