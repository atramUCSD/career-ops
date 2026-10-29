/**
 * `data/ui-state.json`: triage state that used to live only in one browser's
 * localStorage (ADR-001 step 6). On disk it survives a storage clear, is shared by
 * every browser on the PC, and the cloud runner can read it.
 *
 * Only the shortlist lives here. Skips are already durable as `[x]` rows in
 * pipeline.md (inbox-skip.mjs), so the hidden list stays a browser cache.
 */
import fs from "node:fs";
import { postingUrl } from "./posting-url.mjs";

export const SHORTLIST_MAX = 500;
const TEXT_MAX = 300;

/**
 * Keep valid items only: an http(s) posting URL, string company and role, one
 * entry per URL (first wins), at most SHORTLIST_MAX. Never throws.
 *
 * @param {unknown} value
 * @returns {{ url: string, company: string, role: string }[]}
 */
export function normalizeShortlist(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const url = postingUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const text = (v) => (typeof v === "string" ? v.slice(0, TEXT_MAX) : "");
    out.push({ url, company: text(item.company), role: text(item.role) });
    if (out.length === SHORTLIST_MAX) break;
  }
  return out;
}

/**
 * The whole file, with unknown keys kept so a later writer of another key never
 * loses them. A missing or corrupt file reads as empty.
 *
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
export function readUiState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {string} file */
export function readShortlist(file) {
  return normalizeShortlist(readUiState(file).shortlist);
}
