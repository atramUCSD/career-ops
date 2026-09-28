// The web-owned settings in portals.yml, validated into a patch for
// yaml-doc's setIn. Everything the request does not name is left alone, so
// tracked_companies, search_queries and the user's comments are never touched.
// Also what the last scan did with them, from data/scan-runs.tsv.

const LISTS = {
  title_filter: ["positive", "negative", "seniority_boost"],
  location_filter: ["block_hard", "always_allow", "block", "allow"],
};

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** The trimmed, non-empty strings in a list, or null when it is not a list. */
export const words = (v) =>
  Array.isArray(v) ? v.filter((s) => typeof s === "string").map((s) => s.trim()).filter(Boolean) : null;
const count = (v) => Number.isInteger(v) && v >= 0;

/**
 * `roles` (with an optional `location`) is the assistant's onboarding write: it
 * replaces title_filter.positive and, when given, location_filter.allow.
 * `filters` is the Home page's: any subset of the scan filters, each validated
 * against what scan.mjs accepts.
 *
 * @param {Record<string, unknown>} body
 * @returns {{ patch: Record<string, unknown> } | { error: string }}
 */
export function portalsPatch(body) {
  const patch = { title_filter: {}, location_filter: {}, salary_filter: {} };

  if (body.roles !== undefined) {
    const roles = words(body.roles);
    if (!roles?.length) return { error: "no roles" };
    patch.title_filter.positive = roles.slice(0, 24);
    const location = words(body.location);
    if (location?.length) patch.location_filter.allow = location;
  }

  const f = body.filters;
  if (f !== undefined) {
    if (!isObj(f)) return { error: "filters must be an object" };
    for (const block of ["title_filter", "location_filter", "salary_filter"]) {
      if (f[block] !== undefined && !isObj(f[block])) return { error: `${block} must be an object` };
    }
    for (const [block, keys] of Object.entries(LISTS)) {
      for (const key of keys) {
        const value = f[block]?.[key];
        if (value === undefined) continue;
        const list = words(value);
        if (!list) return { error: `${block}.${key} must be a list` };
        patch[block][key] = list;
      }
    }
    const strict = f.location_filter?.strict;
    if (strict !== undefined) {
      if (typeof strict !== "boolean") return { error: "location_filter.strict must be true or false" };
      patch.location_filter.strict = strict;
    }
    const salary = f.salary_filter ?? {};
    for (const key of ["min", "max"]) {
      if (salary[key] === undefined) continue;
      if (!count(salary[key])) return { error: `salary_filter.${key} must be a whole number, 0 or more` };
      patch.salary_filter[key] = salary[key];
    }
    if (salary.currency !== undefined) {
      if (typeof salary.currency !== "string" || !/^[A-Z]{3}$/.test(salary.currency)) {
        return { error: "salary_filter.currency must be a three-letter code such as USD" };
      }
      patch.salary_filter.currency = salary.currency;
    }
    if (f.max_posting_age_days !== undefined) {
      if (!count(f.max_posting_age_days)) return { error: "max_posting_age_days must be a whole number, 0 or more" };
      patch.max_posting_age_days = f.max_posting_age_days;
    }
  }

  for (const block of ["title_filter", "location_filter", "salary_filter"]) {
    if (!Object.keys(patch[block]).length) delete patch[block];
  }
  return Object.keys(patch).length ? { patch } : { error: "nothing to write" };
}

// Where the last scan's postings went. Each filtered_* column and dupes are
// exclusive, so with new_added they sum to found; the ones not named here
// (tier, content, cooldown, blacklist, visa, country) are Other.
/** @type {[string, string, string[]][]} */
const FUNNEL = [
  ["title", "Title", ["filtered_title"]],
  ["location", "Location", ["filtered_location"]],
  ["salary", "Salary", ["filtered_salary"]],
  ["age", "Too old", ["filtered_posting_age", "filtered_posted_date"]],
  ["known", "Already seen", ["dupes"]],
];

/**
 * The latest readable run in data/scan-runs.tsv as a funnel, or null. Read by
 * header name with the same row rules as stats.mjs computeRunStats: a row
 * wider than the header was written under a schema the header no longer
 * describes, and a narrower one is torn.
 */
export function scanFunnel(tsv) {
  const lines = String(tsv ?? "").replace(/\r/g, "").split("\n").filter((l) => l.trim());
  const header = (lines[0] ?? "").split("\t");
  const col = (name) => header.indexOf(name);
  if (col("timestamp") < 0 || col("found") < 0) return null;
  const row = lines
    .slice(1)
    .reverse()
    .map((l) => l.split("\t"))
    .find((c) => c.length === header.length && /^\d{4}-\d{2}-\d{2}/.test(c[col("timestamp")]));
  if (!row) return null;
  const num = (name) => {
    const v = Number(row[col(name)]);
    return col(name) >= 0 && Number.isFinite(v) ? v : 0;
  };
  const found = num("found");
  const added = num("new_added");
  const segments = FUNNEL.map(([key, label, cols]) => ({ key, label, count: cols.reduce((n, c) => n + num(c), 0) }));
  const other = Math.max(0, found - added - segments.reduce((n, s) => n + s.count, 0));
  return {
    at: row[col("timestamp")],
    status: col("status") >= 0 ? row[col("status")] : "completed",
    found,
    segments: [...segments, { key: "other", label: "Other", count: other }, { key: "new", label: "New", count: added }],
  };
}
