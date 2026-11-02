// The setup wizard's draft: one object holding what each existing writer would
// be sent, keyed by the file it lands in. Validation and the edit plan are the
// writers' own libraries, called here rather than re-stated, so the wizard and
// the Home editors cannot accept different things for the same file.

import { alertsPatch } from "./alerts-config.mjs";
import { laneEdits, laneKeywords } from "./lanes-config.mjs";
import { coercePersonalization } from "./personalization.mjs";
import { companyToggles, portalsPatch, words } from "./portals-config.mjs";
import { profileEdits, profilePatchError } from "./profile-patch.mjs";

/** The order apply writes in. The first failure stops it. */
export const APPLY_ORDER = ["portals", "alerts", "profile", "personalization", "lanes"];

const SECTIONS = new Set(["profile", "personalization", "portals", "companies", "lanes", "alerts"]);
const PORTALS_KEYS = new Set(["roles", "location", "filters"]);
const COMPANY_KEYS = new Set(["enable", "disable", "add"]);
// Each added name is one discover-ats probe across every ATS vendor.
const MAX_ADDS = 20;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const extra = (obj, allowed) => Object.keys(obj).find((k) => !allowed.has(k));

/**
 * Validate a draft through each writer's own checks.
 *
 * @param {unknown} draft
 * @returns {{ checked: Record<string, unknown> } | { error: string }}
 *   `checked` holds, per present section: profile edits, the personalization
 *   patch, the portals patch, the companies lists, lane keywords, the alerts patch.
 */
export function checkDraft(draft) {
  if (!isObj(draft)) return { error: "draft must be an object" };
  const unknown = extra(draft, SECTIONS);
  if (unknown) return { error: `unknown draft section "${unknown}"` };
  const checked = {};

  if (draft.profile !== undefined) {
    const invalid = profilePatchError(draft.profile);
    if (invalid) return { error: `profile: ${invalid}` };
    const edits = profileEdits(draft.profile);
    if (typeof edits === "string") return { error: `profile: ${edits}` };
    checked.profile = edits;
  }

  if (draft.personalization !== undefined) {
    if (!isObj(draft.personalization)) return { error: "personalization must be an object" };
    checked.personalization = coercePersonalization(draft.personalization);
  }

  if (draft.portals !== undefined) {
    const p = draft.portals;
    if (!isObj(p)) return { error: "portals must be an object" };
    const bad = extra(p, PORTALS_KEYS);
    if (bad) return { error: `portals: unknown setting "${bad}"` };
    if (p.roles !== undefined || p.filters !== undefined) {
      const result = portalsPatch(p);
      if ("error" in result) return { error: `portals: ${result.error}` };
      checked.portals = result.patch;
    }
  }

  if (draft.companies !== undefined) {
    const c = draft.companies;
    if (!isObj(c)) return { error: "companies must be an object" };
    const bad = extra(c, COMPANY_KEYS);
    if (bad) return { error: `companies: unknown setting "${bad}"` };
    const lists = {};
    for (const key of COMPANY_KEYS) {
      const list = c[key] === undefined ? [] : words(c[key]);
      if (!list) return { error: `companies.${key} must be a list of names` };
      if (list.some((n) => n.length > 100)) return { error: `companies.${key} allows names of at most 100 characters` };
      lists[key] = list;
    }
    if (lists.add.length > MAX_ADDS) return { error: `companies.add allows at most ${MAX_ADDS} names at a time` };
    // The names become discover-ats arguments; one that starts with "-" would be read as a flag.
    const flag = lists.add.find((n) => n.startsWith("-"));
    if (flag) return { error: `"${flag}" is not a company name` };
    checked.companies = lists;
  }

  if (draft.lanes !== undefined) {
    const result = laneKeywords(draft.lanes);
    if ("error" in result) return { error: result.error };
    checked.lanes = result.keywords;
  }

  if (draft.alerts !== undefined) {
    const result = alertsPatch(draft.alerts);
    if ("error" in result) return { error: `alerts: ${result.error}` };
    checked.alerts = result.patch;
  }

  return { checked };
}

/**
 * The files a checked draft writes, in APPLY_ORDER. Company adds are not a
 * file write here: discover-ats.mjs resolves and writes them after the rest.
 * @param {Record<string, any>} checked
 * @returns {string[]}
 */
export function targets(checked) {
  const present = {
    portals: checked.portals !== undefined || (checked.companies && (checked.companies.enable.length || checked.companies.disable.length)),
    alerts: checked.alerts !== undefined,
    profile: checked.profile?.length > 0,
    personalization: checked.personalization && Object.keys(checked.personalization).length > 0,
    lanes: checked.lanes !== undefined,
  };
  return APPLY_ORDER.filter((t) => present[t]);
}

/**
 * `obj` as setIn edits, one per value that is not a plain object. setIn merges
 * a plain object key by key, so this is the same write, one leaf at a time.
 *
 * @param {Array<string | number>} prefix
 * @param {Record<string, unknown>} obj
 * @returns {[Array<string | number>, unknown][]}
 */
export function leaves(prefix, obj) {
  return Object.entries(obj).flatMap(([k, v]) => (isObj(v) ? leaves([...prefix, k], v) : [[[...prefix, k], v]]));
}

/**
 * The setIn edits a checked draft makes to one YAML file, planned against that
 * file's current contents. Company toggles and lanes address list items by
 * index, so apply re-plans inside the file's lock.
 *
 * @param {"portals" | "alerts" | "profile" | "lanes"} target
 * @param {Record<string, any>} checked from checkDraft
 * @param {Record<string, unknown>} current the file as plain data
 * @returns {{ edits: [Array<string | number>, unknown][] } | { error: string }}
 */
export function yamlEdits(target, checked, current) {
  switch (target) {
    case "portals": {
      const edits = leaves([], checked.portals ?? {});
      const { enable = [], disable = [] } = checked.companies ?? {};
      if (!enable.length && !disable.length) return { edits };
      const toggles = companyToggles(current, { enable, disable });
      return "error" in toggles ? toggles : { edits: [...edits, ...toggles.edits] };
    }
    case "alerts":
      // notify-email reads `alerts:` when present and the top level otherwise.
      return { edits: leaves("alerts" in current ? ["alerts"] : [], checked.alerts ?? {}) };
    case "profile":
      return { edits: checked.profile ?? [] };
    case "lanes":
      return checked.lanes ? laneEdits(current, checked.lanes) : { edits: [] };
    default:
      return { error: `${target} is not a YAML target` };
  }
}

/**
 * What `edits` would change in `current`, one row per value that differs.
 *
 * @param {[Array<string | number>, unknown][]} edits
 * @param {Record<string, unknown>} current
 * @returns {{ path: Array<string | number>, before: unknown, after: unknown }[]}
 */
export function changes(edits, current) {
  return edits
    .map(([path, after]) => ({ path, before: path.reduce((o, k) => (o == null ? undefined : o[k]), current), after }))
    .filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
}
