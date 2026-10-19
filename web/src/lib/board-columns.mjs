// Kanban lanes over the canonical tracker states (/board).
//
// Each lane writes exactly one canonical status when a card lands in it, so a
// drag is a plain /api/status call and the board never invents a state the
// core does not know. Pure JS so tests/lib/board-columns.test.mjs can import it.

import { canonStatus } from "./status-alias.mjs";

/** @typedef {{ id: string, label: string, status: string, hint?: string }} BoardColumn */

/** @type {BoardColumn[]} */
export const BOARD_COLUMNS = [
  { id: "apply", label: "Apply", status: "Evaluated", hint: "Evaluated, not sent" },
  { id: "applied", label: "Applied", status: "Applied" },
  // "Responded" in the tracker: an observable event, not a portal's stale label.
  { id: "consideration", label: "In Consideration", status: "Responded", hint: "They replied" },
  { id: "interviewing", label: "Interviewing", status: "Interview" },
  // Hired shares the Offer lane (it is the accepted offer) and keeps its own status.
  { id: "offer", label: "Offer Received", status: "Offer" },
  // Terminal: rendered last and collapsed, so dead cards never bury live ones.
  { id: "rejected", label: "Rejected", status: "Rejected" },
];

// Substring order mirrors statusDot(): canonStatus passes unknown text through
// uppercased, so "APPLIED (2ND ROUND)" still has to land somewhere sensible.
const LANE_BY_CANON = [
  ["HIRED", "offer"],
  ["OFFER", "offer"],
  ["INTERVIEW", "interviewing"],
  ["RESPONDED", "consideration"],
  ["APPLIED", "applied"],
  ["REJECTED", "rejected"],
  ["EVALUATED", "apply"],
];

/**
 * Lane id for a raw tracker status, or null when the row stays off the board
 * (Discarded, SKIP, blank, unknown): those are triage outcomes, not stages.
 * @param {string} status
 * @returns {string | null}
 */
export function boardColumn(status) {
  const c = canonStatus(status);
  if (c.includes("DISCARDED") || c.includes("SKIP")) return null;
  for (const [token, lane] of LANE_BY_CANON) if (c.includes(token)) return lane;
  return null;
}

/** True when the raw status is Hired (shown as a marker inside the Offer lane). */
export function isHired(status) {
  return canonStatus(status).includes("HIRED");
}

/**
 * Whole days from a YYYY-MM-DD tracker date to `today` (also YYYY-MM-DD), or
 * null for anything that is not a date. Both sides parse as UTC midnight, so
 * the difference is exact calendar days regardless of the viewer's timezone.
 * @param {string} date
 * @param {string} today
 * @returns {number | null}
 */
export function daysSince(date, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return null;
  const ms = Date.parse(today) - Date.parse(date);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86_400_000)) : null;
}

const words = (s) => s.trim().split(/\s+/);
const STEM_END = /[\s,:;(\-–—/]+$/;
const TAIL_START = /^[\s,:;\-–—/]+/;

/**
 * Same-company roles that differ only after a shared opening ("Senior
 * Full-Stack Software Engineer, Ads" / "…, Game Records") look identical once
 * a card clamps the title. For each such role, split it into the shared stem
 * and the part that tells it apart, so the card can always show the tail.
 * Roles with no near-twin are absent from the map.
 * @param {{ company: string, role: string }[]} apps
 * @returns {Map<string, { stem: string, tail: string }>} keyed by titleKey()
 */
export function distinctTitles(apps) {
  const out = new Map();
  const byCompany = new Map();
  for (const a of apps) {
    const k = a.company.trim().toLowerCase();
    if (!byCompany.has(k)) byCompany.set(k, new Set());
    byCompany.get(k).add(a.role.trim());
  }
  for (const [company, roleSet] of byCompany) {
    const roles = [...roleSet];
    for (const role of roles) {
      const w = words(role);
      let shared = 0;
      for (const other of roles) {
        if (other === role) continue;
        const o = words(other);
        let i = 0;
        while (i < w.length && i < o.length && w[i] === o[i]) i++;
        shared = Math.max(shared, i);
      }
      // Two words minimum: "Senior Engineer" vs "Senior Designer" already read apart.
      if (shared < 2 || shared >= w.length) continue;
      const stem = w.slice(0, shared).join(" ").replace(STEM_END, "");
      const tail = w.slice(shared).join(" ").replace(TAIL_START, "");
      if (stem && tail) out.set(titleKey(company, role), { stem, tail });
    }
  }
  return out;
}

/** Map key for distinctTitles(). */
export function titleKey(company, role) {
  return `${company.trim().toLowerCase()}\u0000${role.trim()}`;
}

/**
 * True when the report's Machine Summary says not to apply. Those rows stay
 * Evaluated in the tracker, so without this they fill the Apply lane.
 * @param {unknown} decision  summary.final_decision
 */
export function isSkipDecision(decision) {
  return typeof decision === "string" && /^\s*(skip|do not apply|don't apply|pass)\b/i.test(decision);
}
