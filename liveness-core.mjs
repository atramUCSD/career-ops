// Portals write closure banners with typographic punctuation and accents:
// WTTJ renders "Cette offre n’est plus disponible." with U+2019, not ASCII "'".
// A pattern spelled with a plain apostrophe silently never matches, so a clearly
// expired posting fell through to `no_apply_control` → uncertain → never filtered.
// Normalize once at the entry point and spell every pattern below in the
// normalized alphabet: ASCII quotes, no diacritics, collapsed whitespace.
function normalizeForMatch(text = '') {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[‘’ʼ′´`]/g, "'")
    .replace(/[“”″]/g, '"')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  // Generalized "filled" signal. The old /position has been filled/ missed the
  // phrasing SPA ATSs (Phenom, e.g. careers.icf.com) inject on a filled req —
  // "the job you are trying to apply for has been filled" — so those pages
  // returned HTTP 200 with a generic Apply control and were classified active.
  // A job noun within 60 chars, then "has been filled" — but NOT when the thing
  // filled is an application/form (the lookbehind) or "filled out" (the
  // lookahead). Both guards avoid the worse error: reading a LIVE posting whose
  // copy says "once the application form has been filled…" as expired.
  /\b(?:job|jobs|position|role|posting|opening|vacancy|requisition|req|listing)\b[\s\S]{0,60}?(?<!\b(?:application|form)\s)has been filled\b(?!\s+out)/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  // Widened from /this job (listing )?is closed/i: agentic-engineering-jobs.com
  // writes "This role is closed" (111 of 111 uncertain postings measured in
  // one run, #4175), and other boards use "position". The three nouns are
  // interchangeable in JD copy.
  //
  // The trailing \b(?!-) is a compound-adjective guard. Without it,
  // "This role is closed-loop control of the platform" (real prose in a
  // control-systems JD, per santifer's review on #4194) matches the "is
  // closed" fragment and returns expired. \b requires end-of-word after
  // "closed"; (?!-) additionally rejects the hyphen case that \b alone
  // allows (d->- is word->non-word, so \b matches; the lookahead is what
  // catches closed-loop / closed-form / closed-source). "closedown" is
  // rejected by \b alone (d->o is word->word).
  /this (?:job|role|position)(?: listing)? is closed\b(?!-)/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /applications?\s+(?:(?:have|are|is)\s+)?closed/i,
  /closed on \d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /closed on (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  // French closure banners. Spelled accent-free on purpose: normalizeForMatch
  // strips diacritics, so "expiree" here matches "expirée" on the page.
  /offre (expiree|n'est plus disponible)/i,
  /(cette )?offre n'est plus (disponible|en ligne|active)/i,
  /(offre|poste|annonce) (deja )?pourvu(e)?/i,
  /offre (cloturee|desactivee|terminee)/i,
  /ce poste n'est plus (disponible|a pourvoir|ouvert)/i,
  /recrutement (termine|cloture)/i,
  /candidatures (closes|cloturees)/i,
];

const LISTING_PAGE_PATTERNS = [
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
];

// Weak expiry signals: real when nothing else on the page contradicts them,
// but too broad to override a visible apply control. The tier distinction
// exists because HARD_EXPIRED_PATTERNS is checked BEFORE hasApplyControl —
// anything placed there wins over a live Apply button on the page.
//
// /\bjob expired\b/i lived in HARD_EXPIRED_PATTERNS in the first cut of #4175
// and false-fired on four live-posting shapes santifer measured in the #4194
// review: a "Similar jobs" carousel with a "Job Expired" entry, a "Hide job
// expired" filter chip, a footer FAQ asking "what happens when a job
// expired?", and — before the closed-loop guard on the closed pattern above —
// "This role is closed-loop control of the platform" prose. liveness-browser
// hands classifyLiveness the whole page innerText plus same-origin iframe
// text (liveness-browser.mjs:434), so those elements are in scope.
//
// Moved down here so the same phrase in a dead-page scenario (nodesk.co's
// bare "JOB EXPIRED" banner, no apply control, per #4175) still fires. The
// pre-existing comments on the 5xx and 429 guards spell out the underlying
// rule: a false `expired` is written to scan-history as skipped_expired and
// dedup-filters a real job out of every later scan (indefinitely, unless
// scan_history.recheck_after_days is set), so this direction of error is
// always the more expensive one.
const SOFT_EXPIRED_PATTERNS = [
  /\bjob expired\b/i,
];

// Anti-bot interstitials (Cloudflare "Just a moment...", hCaptcha walls, etc.)
// render a tiny challenge page instead of the posting. Headless Playwright trips
// these on portals like pracuj.pl. They must NOT be read as expired: the body is
// short and lacks an apply control, so without this guard they fall through to
// `insufficient_content` → expired, and scan --verify would write live jobs to
// scan-history and permanently filter them out. Treat as uncertain instead.
const BOT_CHALLENGE_PATTERNS = [
  /just a moment/i,
  /performing security verification/i,
  /checking your browser before/i,
  /verify you are (a |not a )?human/i,
  /enable javascript and cookies to continue/i,
  /attention required.*cloudflare/i,
  /\bray id\b/i,
  /\bcf-ray\b/i,
  /please complete the security check/i,
];

const EXPIRED_URL_PATTERNS = [
  /[?&]error=true/i,
];

const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
  // Polish (pracuj.pl, justjoin.it, bulldogjob.pl): "Aplikuj" / "Aplikuj teraz" /
  // "Wyślij CV" / "Przejdź do panelu aplikowania". Without these, a fully-loaded
  // Polish posting has no recognized apply control and falls to no_apply_control.
  /\baplikuj\b/i,
  /panelu aplikowania/i,
  // Accent-free: apply controls go through normalizeForMatch too ("wyślij" → "wyslij").
  /wyslij (cv|aplikacj)/i,
  // SmartRecruiters never writes "Apply" on the button — its call to action is
  // "I'm interested" (curly apostrophe on the page, ASCII after normalization).
  // Without this every live SmartRecruiters posting reads `no_apply_control` and
  // stays uncertain forever, which is why 32 of them were unprunable.
  /\bi'?m interested\b/i,
  // Chinese MokaHR and Feishu Jobs detail pages use these exact control texts.
  // Keep them narrow: bare “申请” appears in descriptive prose, while longer
  // labels containing “投递” can be status/history controls rather than Apply.
  /^申请职位$/,
  /^投递$/,
];

export const MIN_CONTENT_CHARS = 300;

// A job-detail URL almost always carries the posting's identity: a numeric req id
// (Greenhouse, Workday pid, Microsoft) or a UUID (Lever, Ashby). If the requested
// URL had one and the final URL lost it, the browser landed somewhere else.
const JOB_ID_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{5,}/gi;

function jobIdToken(url = '') {
  const matches = url.match(JOB_ID_TOKEN);
  return matches ? matches[matches.length - 1].toLowerCase() : null;
}

function firstMatch(patterns, text = '') {
  return patterns.find((pattern) => pattern.test(text));
}

function hasApplyControl(controls = []) {
  return controls.some((control) => APPLY_PATTERNS.some((pattern) => pattern.test(control)));
}

export function classifyLiveness({ status = 0, requestedUrl = '', finalUrl = '', bodyText: rawBodyText = '', applyControls: rawApplyControls = [] } = {}) {
  const bodyText = normalizeForMatch(rawBodyText);
  const applyControls = (Array.isArray(rawApplyControls) ? rawApplyControls : []).map(normalizeForMatch);

  if (status === 404 || status === 410) {
    return { result: 'expired', code: 'http_gone', reason: `HTTP ${status}` };
  }

  // Bot/anti-scraping walls — never expired. Check before the content-length and
  // listing-page heuristics, which would otherwise misread the short challenge
  // body as a dead posting. 403/503 are access-blocked signals, not "gone"
  // (a genuinely removed posting returns 404/410 or a hard-expired banner).
  const botChallenge = firstMatch(BOT_CHALLENGE_PATTERNS, bodyText);
  if (botChallenge) {
    return { result: 'uncertain', code: 'bot_challenge', reason: `anti-bot challenge: ${botChallenge.source}` };
  }
  // 429 belongs with 403/503: rate limiting is the board throttling US, never
  // evidence the posting is gone. Its body is a short "Too Many Requests", well
  // under MIN_CONTENT_CHARS, so without this it fell through to
  // insufficient_content and read as `expired` — and an expired result is
  // written to scan-history as skipped_expired, whose URL every later scan
  // dedup-skips (indefinitely, unless scan_history.recheck_after_days is set).
  // Scanning harder is exactly what earns a 429, so this compounds.
  if (status === 403 || status === 429 || status === 503) {
    return { result: 'uncertain', code: 'access_blocked', reason: `HTTP ${status} (access blocked, likely anti-bot)` };
  }
  // Any other 5xx is a transient origin error (502/504 gateway hiccups, 500s
  // during deploys), not evidence the posting is gone. Without this guard the
  // short error body ("502 Bad Gateway / nginx") falls through to the
  // insufficient-content heuristic and reads as expired — and a false
  // "expired" permanently dedup-filters a real job out of future scans.
  if (status >= 500) {
    return { result: 'uncertain', code: 'server_error', reason: `HTTP ${status} (transient server error)` };
  }

  const expiredUrl = firstMatch(EXPIRED_URL_PATTERNS, finalUrl);
  if (expiredUrl) {
    return { result: 'expired', code: 'expired_url', reason: `redirect to ${finalUrl}` };
  }

  const expiredBody = firstMatch(HARD_EXPIRED_PATTERNS, bodyText);
  if (expiredBody) {
    return { result: 'expired', code: 'expired_body', reason: `pattern matched: ${expiredBody.source}` };
  }

  // A dead permalink that 301s to a generic search/listing page still shows
  // "Apply" buttons — on OTHER jobs' cards (seen when jobs.careers.microsoft.com
  // permalinks migrated to apply.careers.microsoft.com). When the requested URL
  // carried a job identifier and the final URL lost it, the page being read is
  // not the posting, so apply controls are not evidence of liveness. Uncertain,
  // not expired: a portal migration can 301 live postings too, and a false
  // "expired" permanently filters a real job out of scans.
  const jobId = jobIdToken(requestedUrl);
  if (jobId && finalUrl && !finalUrl.toLowerCase().includes(jobId)) {
    return {
      result: 'uncertain',
      code: 'redirected_off_posting',
      reason: `redirected to ${finalUrl} — job id "${jobId}" missing from final URL`,
    };
  }

  if (hasApplyControl(applyControls)) {
    return { result: 'active', code: 'apply_control_visible', reason: 'visible apply control detected' };
  }

  // Weak expiry signals — see SOFT_EXPIRED_PATTERNS above for why these
  // live below the apply-control check rather than in HARD_EXPIRED_PATTERNS.
  const softExpired = firstMatch(SOFT_EXPIRED_PATTERNS, bodyText);
  if (softExpired) {
    return { result: 'expired', code: 'expired_body_soft', reason: `pattern matched: ${softExpired.source}` };
  }

  const listingPage = firstMatch(LISTING_PAGE_PATTERNS, bodyText);
  if (listingPage) {
    return { result: 'expired', code: 'listing_page', reason: `pattern matched: ${listingPage.source}` };
  }

  if (bodyText.trim().length < MIN_CONTENT_CHARS) {
    // A body this short means the posting was not RENDERED, which is not evidence
    // that it was removed. iCIMS serves the job detail inside an iframe, so headless
    // Playwright reads nav/footer only and every live careers-peraton.icims.com
    // posting scored `expired` — 14 of them on one run, whose URLs the same day's
    // scan had just pulled from the live iCIMS feed. Purging on that verdict deletes
    // open roles.
    //
    // This is the failure the BOT_CHALLENGE_PATTERNS comment above already argues
    // against, met a second time with no pattern available to match on: absence of
    // readable content cannot be distinguished from absence of the posting. So it
    // resolves the way the weaker no_apply_control signal below does — uncertain,
    // left for an API check or a human to settle.
    return { result: 'uncertain', code: 'insufficient_content', reason: 'insufficient content — likely nav/footer only (page may not have rendered)' };
  }

  return { result: 'uncertain', code: 'no_apply_control', reason: 'content present but no visible apply control found' };
}

// ── Full-list absence ────────────────────────────────────────────────────────
// Some ATSs (Ashby, Pinpoint, Breezy, Rippling, Jobvite, Teamtailor, Personio)
// return the tenant's ENTIRE board in one successful response. Against that
// list, absence is proof of removal exactly as a per-job 404 is — but ONLY
// against a fetch that actually succeeded. A failed or unreadable fetch is not
// a full list, and absence from it proves nothing; reading it as expired is the
// same false-expired failure every guard above defends against.

// Compare a posting URL against a listed job URL: scheme, query, fragment and a
// trailing slash never distinguish two postings on the same board, so drop them
// and lowercase the rest (no board publishes two postings differing by case).
function normalizeForListMatch(raw = '') {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return '';
  }
  return `${u.hostname}${u.pathname}`.toLowerCase().replace(/\/+$/, '');
}

export function classifyFullListAbsence({ fetchSucceeded = false, jobs, targetUrl = '', provider = 'board' } = {}) {
  // The load-bearing branch, first: a fetch that did not succeed must NEVER
  // read as removal.
  if (!fetchSucceeded) {
    return { result: 'uncertain', code: 'full_list_fetch_failed', reason: `${provider} board fetch failed — absence unproven, not expired` };
  }
  if (!Array.isArray(jobs)) {
    return { result: 'uncertain', code: 'full_list_unreadable', reason: `${provider} board returned an unexpected shape — absence unproven` };
  }
  // Every provider parser launders an unreadable payload into [] (Pinpoint
  // {"data": null}, an RSS feed with zero <item>s, non-array JSON), so an
  // EMPTY successful list is indistinguishable from a broken one here —
  // absence from it is not proof and must never classify expired.
  if (jobs.length === 0) {
    return { result: 'uncertain', code: 'full_list_empty', reason: `${provider} board fetch returned zero jobs — empty and unreadable are indistinguishable, absence unproven` };
  }
  const target = normalizeForListMatch(targetUrl);
  // Branded job links (Teamtailor, Jobvite) and /application suffixes (Ashby)
  // change the URL without changing the posting, so a shared job id token also
  // counts as presence. Bounded, so id "12345" never matches inside "123456".
  // jobIdToken yields only hex/digits/hyphens — no regex metacharacters.
  const id = jobIdToken(targetUrl);
  const idRe = id ? new RegExp(`(^|[^0-9a-z])${id}([^0-9a-z]|$)`, 'i') : null;
  if (!target && !idRe) {
    return { result: 'uncertain', code: 'full_list_no_target', reason: 'no usable posting URL or id to look for — absence unproven' };
  }
  for (const job of jobs) {
    const jobUrl = typeof job?.url === 'string' ? job.url : '';
    if (!jobUrl) continue;
    const listed = normalizeForListMatch(jobUrl);
    // A tracked URL may extend the listed one with a suffix path on the same
    // posting (a Jobvite apply URL .../job/{id}/apply vs the feed's
    // .../job/{id}), and Jobvite ids are alphanumeric so no id token can
    // rescue the match — a target extending a listed URL also counts as present.
    if ((target && listed && (listed === target || target.startsWith(listed + '/'))) || (idRe && idRe.test(jobUrl))) {
      return { result: 'active', code: 'full_list_present', reason: `posting is listed on the ${provider} board (live)` };
    }
  }
  return { result: 'expired', code: 'full_list_absent', reason: `full-list-absence rule: missing from a successful full ${provider} board fetch (${jobs.length} jobs listed)` };
}
