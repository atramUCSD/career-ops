// The setup wizard's form: one flat object the stages edit, read from what
// GET /api/setup returns and written back as the draft POST /api/setup takes.
// The draft names only what differs from the files, so applying an untouched
// wizard writes nothing once the files are filled in (for a new user, alerts
// follow the profile email and personalization fills empty sections). Validation here is the wizard's own (required fields,
// in the wizard's words); the writers' libraries still check the draft on POST.

import { EMAIL } from "./alerts-config.mjs";

/** @typedef {{ id: string, label: string, title: string }} Stage */

/** @type {Stage[]} */
export const STAGES = [
  { id: "you", label: "You", title: "Is your CV here?" },
  { id: "what", label: "What", title: "Which roles should we look for?" },
  { id: "where", label: "Where", title: "Where can you work?" },
  { id: "who", label: "Who", title: "Which companies should we watch?" },
  { id: "picky", label: "How picky", title: "How good must a match be?" },
  { id: "tell", label: "Tell me", title: "Where should alerts go?" },
  { id: "when", label: "When", title: "When does it run?" },
];
export const STAGE_IDS = STAGES.map((s) => s.id);

/** A stage's place in the wizard, for the page title and the rail. Anything else is the review. */
export function stageLabel(id) {
  const i = STAGE_IDS.indexOf(id);
  return i < 0 ? "Review" : `Step ${i + 1} of ${STAGES.length}: ${STAGES[i].label}`;
}

export const REMOTE = ["Remote only", "Remote or hybrid", "Hybrid or on-site", "Anywhere"];

const MAX_TEXT = 200;
// Mirrors checkDraft in setup-draft.mjs and NOT_A_PLACE in the root onboard-write.mjs.
const MAX_ADDS = 20;
const MAX_NAME = 100;
const NOT_A_PLACE = /^(remote|hybrid|anywhere|on-?site)$/i;

// Form field to the profile draft key profile-patch.mjs reads.
const PROFILE = [
  ["name", "name"],
  ["email", "email"],
  ["currency", "currency"],
  ["targetRange", "targetRange"],
  ["walkAway", "walkAway"],
  ["home", "location"],
  ["remote", "remote"],
];
// Form field to the alerts.yml key.
const ALERTS = [
  ["alertsOn", "enabled"],
  ["to", "to"],
  ["minMatch", "min_match"],
  ["maxRows", "max_rows"],
  ["quiet", "quiet_if_empty"],
];

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const list = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string") : []);
const int = (v, d) => (Number.isInteger(v) ? v : d);
const bool = (v, d) => (typeof v === "boolean" ? v : d);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ok = (s) => (isObj(s) && !("error" in s) ? s : null);

/**
 * What the files say, as the form. A section the example seeded shows empty
 * rather than the example's values (an example person, someone else's
 * keywords); seeded portals still list the shipped companies, since watching
 * them is a real choice the user makes here. Alert defaults are the example's.
 *
 * @param {Record<string, any>} setup GET /api/setup
 */
export function baseFrom(setup) {
  const profile = ok(setup.profile);
  const portals = ok(setup.portals);
  const p = profile && !profile.seeded ? profile.value ?? {} : {};
  const pt = portals?.value ?? {};
  const fresh = !portals || portals.seeded;
  const a = ok(setup.alerts)?.value ?? {};
  return {
    name: str(p.name),
    email: str(p.email),
    roles: list(p.roles),
    // Keywords addRole added in this session, so removing the role can take them back out.
    roleKeywords: /** @type {string[]} */ ([]),
    keywords: fresh ? [] : list(pt.title_filter?.positive),
    lanes: Object.fromEntries((ok(setup.lanes)?.value ?? []).filter((l) => typeof l?.id === "string").map((l) => [l.id, list(l.title_keywords)])),
    currency: str(p.currency),
    targetRange: str(p.targetRange),
    walkAway: str(p.walkAway),
    home: str(p.location),
    remote: str(p.remote),
    places: fresh ? [] : list(pt.location_filter?.allow),
    companies: Object.fromEntries((pt.companies ?? []).map((c) => [c.name, c.enabled !== false])),
    adds: /** @type {string[]} */ ([]),
    minMatch: int(a.min_match, 42),
    maxRows: int(a.max_rows, 15),
    quiet: bool(a.quiet_if_empty, true),
    alertsOn: bool(a.enabled, true),
    to: Array.isArray(a.to) ? list(a.to).join(", ") : str(a.to),
    calendarOn: bool(a.calendar?.enabled, false),
  };
}

/**
 * The form the wizard opens on: the files, then the saved draft over them.
 * Alerts go to the profile email until the user names another address.
 *
 * @param {Record<string, any>} setup GET /api/setup
 */
export function formFrom(setup) {
  const form = baseFrom(setup);
  const d = ok(setup.draft)?.value;
  if (isObj(d)) {
    const pr = isObj(d.profile) ? d.profile : {};
    for (const [field, key] of PROFILE) if (typeof pr[key] === "string") form[field] = pr[key];
    if (Array.isArray(pr.roles)) form.roles = list(pr.roles);
    const f = d.portals?.filters;
    if (Array.isArray(f?.title_filter?.positive)) form.keywords = list(f.title_filter.positive);
    if (Array.isArray(f?.location_filter?.allow)) form.places = list(f.location_filter.allow);
    const c = isObj(d.companies) ? d.companies : {};
    for (const n of list(c.enable)) if (n in form.companies) form.companies[n] = true;
    for (const n of list(c.disable)) if (n in form.companies) form.companies[n] = false;
    form.adds = list(c.add);
    if (isObj(d.lanes)) for (const [id, kw] of Object.entries(d.lanes)) if (id in form.lanes) form.lanes[id] = list(kw);
    const al = isObj(d.alerts) ? d.alerts : {};
    for (const [field, key] of ALERTS) if (al[key] !== undefined) form[field] = al[key];
    if (typeof al.calendar?.enabled === "boolean") form.calendarOn = al.calendar.enabled;
  }
  if (!form.to.trim()) form.to = form.email;
  return form;
}

/** Change the email; alerts keep following it until the user names another address. */
export function setEmail(form, email) {
  const follows = !form.to.trim() || form.to.trim() === form.email.trim();
  return { ...form, email, ...(follows && { to: email }) };
}

/** Add a role, and its title keyword when the scan filter lacks it. */
export function addRole(form, role) {
  const r = role.trim();
  const has = (xs) => xs.some((x) => x.toLowerCase() === r.toLowerCase());
  if (!r || has(form.roles)) return form;
  if (has(form.keywords)) return { ...form, roles: [...form.roles, r] };
  return { ...form, roles: [...form.roles, r], keywords: [...form.keywords, r], roleKeywords: [...form.roleKeywords, r] };
}

/**
 * The roles ChipList's new value. A removed role takes its keyword with it only
 * when addRole added that keyword; one the user typed or the files already had stays.
 */
export function setRoles(form, next) {
  const gone = new Set(form.roles.filter((r) => !next.includes(r)).map((r) => r.toLowerCase()));
  const drop = new Set(form.roleKeywords.filter((k) => gone.has(k.toLowerCase())));
  const kept = {
    ...form,
    roles: next.filter((r) => form.roles.includes(r)),
    keywords: form.keywords.filter((k) => !drop.has(k)),
    roleKeywords: form.roleKeywords.filter((k) => !drop.has(k)),
  };
  return next.reduce(addRole, kept);
}

/** The keywords ChipList's new value. A keyword removed by hand stops being the role's. */
export const setKeywords = (form, keywords) => ({ ...form, keywords, roleKeywords: form.roleKeywords.filter((k) => keywords.includes(k)) });

/**
 * The _profile.md sections the answers can fill, for sections the user has not
 * written yet. Restates the answers; adds nothing they did not say.
 */
function personalization(form, unfilled) {
  const out = {};
  const open = new Set(unfilled);
  if (open.has("targetRoles") && form.roles.length) {
    out.targetRoles = form.roles.slice(0, 8).map((r) => ({ archetype: r.slice(0, 80) }));
  }
  if (open.has("compTargets") && form.targetRange.trim()) {
    const cur = form.currency.trim() ? ` ${form.currency.trim()}` : "";
    out.compTargets = `Target ${form.targetRange.trim()}${cur}.${form.walkAway.trim() ? ` Walk-away ${form.walkAway.trim()}.` : ""}`;
  }
  if (open.has("locationPolicy")) {
    const lines = [
      form.home.trim() && `Based in ${form.home.trim()}.`,
      form.remote.trim() && `Work mode: ${form.remote.trim()}.`,
      form.places.length && `Open to roles in ${form.places.join(", ")}.`,
    ].filter(Boolean);
    if (lines.length) out.locationPolicy = lines;
  }
  return out;
}

/**
 * The draft POST /api/setup takes: only what differs from `base`.
 *
 * @param {ReturnType<typeof baseFrom>} form
 * @param {ReturnType<typeof baseFrom>} base what the files say (baseFrom)
 * @param {string[]} [unfilled] _profile.md section ids whose state is not "filled"
 */
export function draftFrom(form, base, unfilled = []) {
  const draft = {};

  const profile = {};
  for (const [field, key] of PROFILE) if (form[field].trim() !== base[field].trim()) profile[key] = form[field].trim();
  if (!same(form.roles, base.roles)) profile.roles = form.roles;
  if (Object.keys(profile).length) draft.profile = profile;

  const filters = {};
  if (!same(form.keywords, base.keywords)) filters.title_filter = { positive: form.keywords };
  if (!same(form.places, base.places)) filters.location_filter = { allow: form.places };
  if (Object.keys(filters).length) draft.portals = { filters };

  const names = Object.keys(base.companies);
  const enable = names.filter((n) => form.companies[n] === true && !base.companies[n]);
  const disable = names.filter((n) => form.companies[n] === false && base.companies[n]);
  if (enable.length || disable.length || form.adds.length) {
    draft.companies = { ...(enable.length && { enable }), ...(disable.length && { disable }), ...(form.adds.length && { add: form.adds }) };
  }

  const lanes = Object.fromEntries(Object.entries(form.lanes).filter(([id, kw]) => !same(kw, base.lanes[id])));
  if (Object.keys(lanes).length) draft.lanes = lanes;

  const alerts = {};
  for (const [field, key] of ALERTS) if (form[field] !== base[field]) alerts[key] = form[field];
  if (form.calendarOn !== base.calendarOn) alerts.calendar = { enabled: form.calendarOn };
  if (Object.keys(alerts).length) draft.alerts = alerts;

  const pz = personalization(form, unfilled);
  if (Object.keys(pz).length) draft.personalization = pz;
  return draft;
}

const tooLong = (label) => `${label} must be ${MAX_TEXT} characters or fewer`;

/**
 * The stage's errors in GOV.UK wording, keyed by field id, in page order.
 * Empty when the stage can continue.
 *
 * @param {string} stage
 * @param {ReturnType<typeof baseFrom>} form
 * @returns {Record<string, string>}
 */
export function validate(stage, form) {
  const e = {};
  const text = (field, label, required) => {
    const v = form[field].trim();
    if (!v && required) e[field] = required;
    else if (v.length > MAX_TEXT) e[field] = tooLong(label);
  };
  switch (stage) {
    case "you":
      text("name", "Name", "Enter your name");
      if (!form.email.trim()) e.email = "Enter your email address";
      else if (!EMAIL.test(form.email.trim())) e.email = "Enter an email address in the correct format, like name@example.com";
      break;
    case "what":
      if (!form.roles.length) e.roles = "Add at least one role";
      if (!form.keywords.length) e.keywords = "Add at least one search keyword";
      for (const [id, kw] of Object.entries(form.lanes)) if (!kw.length) e[`lane-${id}`] = `Give the ${id} lane at least one keyword`;
      text("targetRange", "Target pay");
      text("walkAway", "Walk-away pay");
      text("currency", "Currency");
      break;
    case "where":
      text("home", "Where you live", "Enter where you live");
      text("remote", "Work mode");
      {
        const place = form.places.find((p) => NOT_A_PLACE.test(p.trim()));
        if (place) e.places = `Remove "${place.trim()}": it is not a place. Leave places empty to search anywhere`;
      }
      break;
    case "who": {
      const flag = form.adds.find((n) => n.startsWith("-"));
      if (form.adds.length > MAX_ADDS) e.adds = `Add at most ${MAX_ADDS} companies at a time`;
      else if (flag) e.adds = `Remove "${flag}": a company name cannot start with "-"`;
      else if (form.adds.some((n) => n.length > MAX_NAME)) e.adds = `Company names must be ${MAX_NAME} characters or fewer`;
      break;
    }
    case "picky":
      if (!Number.isInteger(form.minMatch) || form.minMatch < 0 || form.minMatch > 100) e.minMatch = "Match score must be a whole number from 0 to 100";
      if (!Number.isInteger(form.maxRows) || form.maxRows < 1 || form.maxRows > 100) e.maxRows = "Matches per alert must be a whole number from 1 to 100";
      break;
    case "tell": {
      const addresses = form.to.split(",").map((s) => s.trim()).filter(Boolean);
      const bad = addresses.find((a) => !EMAIL.test(a));
      if (form.to.length > MAX_TEXT) e.to = tooLong("Alert addresses");
      else if (bad) e.to = `Enter "${bad}" as an email address, like name@example.com`;
      else if (form.alertsOn && !addresses.length) e.to = "Enter an email address for alerts, or turn alerts off";
      break;
    }
  }
  return e;
}

/**
 * "done" or "todo" for the overview's task list. A stage with errors is todo;
 * so is You without a CV, and Who watching no company.
 * @param {string} stage
 * @param {ReturnType<typeof baseFrom>} form
 * @param {{ hasCv: boolean }} ctx
 */
export function status(stage, form, ctx) {
  if (Object.keys(validate(stage, form)).length) return "todo";
  if (stage === "you" && !ctx.hasCv) return "todo";
  if (stage === "who" && !Object.values(form.companies).some(Boolean) && !form.adds.length) return "todo";
  return "done";
}

/** Score counts in `n` equal buckets over 0 to 100; 100 lands in the last. */
export function bins(scores, n = 20) {
  const out = Array(n).fill(0);
  for (const s of scores) if (Number.isFinite(s)) out[Math.min(n - 1, Math.max(0, Math.floor((s / 100) * n)))]++;
  return out;
}

/** How many scores reach `min`. */
export const passing = (scores, min) => scores.filter((s) => s >= min).length;
