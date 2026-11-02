/** Validate untrusted JSON before the profile route reads or writes user files.
 * @param {unknown} value
 * @returns {string | null} An actionable error, or null for a valid partial patch.
 */
export function profilePatchError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "profile update must be an object";
  }
  for (const field of ["name", "email", "location", "currency", "remote"]) {
    if (field in value && typeof value[field] !== "string") {
      return `${field} must be a string`;
    }
  }
  if ("roles" in value && (!Array.isArray(value.roles) || value.roles.some((role) => typeof role !== "string"))) {
    return "roles must be an array of strings";
  }
  // The action can send a lone bound. The writer ignores it while saving
  // other fields, so do not require a pair here.
  for (const field of ["compMin", "compMax"]) {
    if (field in value && (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] <= 0)) {
      return `${field} must be a positive finite number`;
    }
  }
  if (typeof value.compMin === "number" && typeof value.compMax === "number" && value.compMin > value.compMax) {
    return "compMin must not exceed compMax";
  }
  return null;
}

const TEXT = {
  name: ["candidate", "full_name"],
  email: ["candidate", "email"],
  location: ["candidate", "location"],
  currency: ["compensation", "currency"],
  remote: ["compensation", "location_flexibility"],
  targetRange: ["compensation", "target_range"],
  walkAway: ["compensation", "minimum"],
};
const SPEND_TIERS = new Set(["economy", "standard", "premium"]);

/**
 * A patch that passed profilePatchError, as setIn edits on config/profile.yml,
 * or an error message. Empty text is skipped, not cleared.
 * @param {Record<string, unknown>} p
 * @returns {[string[], unknown][] | string}
 */
export function profileEdits(p) {
  const edits = [];
  for (const [field, keys] of Object.entries(TEXT)) {
    const v = p[field];
    if (v == null) continue;
    if (typeof v !== "string" || v.length > 200) return `${field} must be text of at most 200 characters`;
    if (v.trim()) edits.push([keys, v.trim()]);
  }
  if (p.roles !== undefined) {
    if (!Array.isArray(p.roles) || p.roles.some((r) => typeof r !== "string")) return "roles must be a list of text";
    const roles = p.roles.map((r) => r.trim()).filter(Boolean).slice(0, 24);
    if (roles.length) edits.push([["target_roles", "primary"], roles]);
  }
  // The assistant's shape: a numeric range the user stated.
  const { compMin, compMax } = p;
  if (typeof compMin === "number" && typeof compMax === "number" && compMin > 0 && compMax > 0) {
    edits.push([["compensation", "target_range"], `${compMin}-${compMax}`]);
  }
  if (p.language !== undefined) {
    if (typeof p.language !== "string" || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(p.language)) {
      return "language must be a language code such as en or pt-BR";
    }
    edits.push([["language", "output"], p.language]);
  }
  if (p.spendTier !== undefined) {
    if (typeof p.spendTier !== "string" || !SPEND_TIERS.has(p.spendTier)) {
      return "spendTier must be economy, standard or premium";
    }
    edits.push([["spend_tier"], p.spendTier]);
  }
  // seniority intentionally not written (no canonical home in profile.yml);
  // archetypes/narrative live in modes/_profile.md — this writer never touches them.
  return edits;
}

/**
 * The fields profileEdits writes, read back from config/profile.yml as plain
 * data, so a form can start from what the file already says.
 * @param {Record<string, any>} js
 * @returns {Record<string, string | number | string[]>}
 */
export function profileValues(js) {
  const at = (keys) => keys.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), js);
  const out = {};
  for (const [field, keys] of [...Object.entries(TEXT), ["language", ["language", "output"]], ["spendTier", ["spend_tier"]]]) {
    const v = at(keys);
    if (typeof v === "string" || typeof v === "number") out[field] = v;
  }
  const roles = at(["target_roles", "primary"]);
  if (Array.isArray(roles)) out.roles = roles.filter((r) => typeof r === "string");
  return out;
}
