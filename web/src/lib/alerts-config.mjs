// Validates Home's digest editor before it writes config/alerts.yml.
// notify-email.mjs puts `to` straight into the To: header of the MIME message,
// so a line break there would add headers to mail sent from the user's account.

const EMAIL = /^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/;
const INTS = { min_match: [0, 100], max_rows: [1, 100] };
const BOOLS = ["enabled", "quiet_if_empty", "attach_artifact"];
const CONTROL = /[\x00-\x1f\x7f]/;
// Mirrors calendarConfig in the root calendar-alert.mjs; the test checks every
// accepted patch against it, so the two cannot drift apart silently.
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const CAL_INTS = { min_match: [0, 100], minutes: [5, 240] };
const CAL_LISTS = ["companies", "keywords", "locations", "exclude_hosts"];
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The settings named in `config`, validated, or the first thing wrong with them.
 * An empty `to` is allowed: it is how a digest is left without a recipient.
 *
 * @returns {{ patch: Record<string, unknown> } | { error: string }}
 */
export function alertsPatch(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return { error: "config must be an object" };
  const patch = {};
  if (config.to !== undefined) {
    if (typeof config.to !== "string" || config.to.length > 200 || CONTROL.test(config.to)) {
      return { error: "to must be one line of at most 200 characters" };
    }
    const addresses = config.to.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = addresses.find((a) => !EMAIL.test(a));
    if (bad) return { error: `"${bad}" is not an email address` };
    patch.to = addresses.join(", ");
  }
  for (const [key, [min, max]] of Object.entries(INTS)) {
    const v = config[key];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < min || v > max) return { error: `${key} must be a whole number from ${min} to ${max}` };
    patch[key] = v;
  }
  for (const key of BOOLS) {
    const v = config[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") return { error: `${key} must be true or false` };
    patch[key] = v;
  }
  if (config.calendar !== undefined) {
    const cal = calendarPatch(config.calendar);
    if (cal.error) return cal;
    patch.calendar = cal.patch;
  }
  return Object.keys(patch).length ? { patch } : { error: "nothing to write" };
}

// The calendar: block. Its patch merges key by key under alerts.calendar, so a
// field left out keeps whatever the file has.
function calendarPatch(cal) {
  if (!cal || typeof cal !== "object" || Array.isArray(cal)) return { error: "calendar must be an object" };
  const patch = {};
  if (cal.enabled !== undefined) {
    if (typeof cal.enabled !== "boolean") return { error: "calendar.enabled must be true or false" };
    patch.enabled = cal.enabled;
  }
  for (const [key, [min, max]] of Object.entries(CAL_INTS)) {
    const v = cal[key];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < min || v > max) return { error: `calendar.${key} must be a whole number from ${min} to ${max}` };
    patch[key] = v;
  }
  for (const key of CAL_LISTS) {
    const v = cal[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length > 100) return { error: `calendar.${key} must be a list of at most 100 entries` };
    const items = [];
    for (const item of v) {
      if (typeof item !== "string" || item.length > 100 || CONTROL.test(item)) return { error: `calendar.${key} entries must be one line of at most 100 characters` };
      const t = key === "exclude_hosts" ? item.trim().toLowerCase() : item.trim();
      if (!t) continue;
      if (key === "exclude_hosts" && !HOST.test(t)) return { error: `"${t}" is not a host name` };
      if (!items.includes(t)) items.push(t);
    }
    patch[key] = items;
  }
  if (cal.at !== undefined) {
    if (typeof cal.at !== "string" || !HHMM.test(cal.at)) return { error: "calendar.at must be a 24-hour time like 21:00" };
    patch.at = cal.at;
  }
  if (cal.time_zone !== undefined) {
    if (typeof cal.time_zone !== "string" || !cal.time_zone || cal.time_zone.length > 64) return { error: "calendar.time_zone must be an IANA zone like America/Los_Angeles" };
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: cal.time_zone });
    } catch {
      return { error: `"${cal.time_zone}" is not a time zone` };
    }
    patch.time_zone = cal.time_zone;
  }
  if (cal.calendar_id !== undefined) {
    if (typeof cal.calendar_id !== "string" || !cal.calendar_id.trim() || cal.calendar_id.length > 200 || CONTROL.test(cal.calendar_id)) {
      return { error: "calendar.calendar_id must be one line of at most 200 characters" };
    }
    patch.calendar_id = cal.calendar_id.trim();
  }
  return Object.keys(patch).length ? { patch } : { error: "calendar has nothing to write" };
}
