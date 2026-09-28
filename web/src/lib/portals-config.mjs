// The web-owned settings in portals.yml, validated into a patch for
// yaml-doc's setIn. Everything the request does not name is left alone, so
// tracked_companies, search_queries and the user's comments are never touched.

const LISTS = {
  title_filter: ["positive", "negative", "seniority_boost"],
  location_filter: ["block_hard", "always_allow", "block", "allow"],
};

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const words = (v) =>
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
