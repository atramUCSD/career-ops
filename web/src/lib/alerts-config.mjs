// Validates Home's digest editor before it writes config/alerts.yml.
// notify-email.mjs puts `to` straight into the To: header of the MIME message,
// so a line break there would add headers to mail sent from the user's account.

const EMAIL = /^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/;
const INTS = { min_match: [0, 100], max_rows: [1, 100] };
const BOOLS = ["enabled", "quiet_if_empty", "attach_artifact"];

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
    if (typeof config.to !== "string" || config.to.length > 200 || /[\x00-\x1f\x7f]/.test(config.to)) {
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
  return Object.keys(patch).length ? { patch } : { error: "nothing to write" };
}
