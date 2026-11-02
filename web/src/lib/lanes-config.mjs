// The lane editor's write to config/lanes.yml: title_keywords for named lanes
// and nothing else. Lanes are added by hand, so an unknown lane id is an
// error, never a new lane.

import { words } from "./portals-config.mjs";

/**
 * Validate `{ [laneId]: string[] }` into trimmed keyword lists.
 * @param {unknown} value
 * @returns {{ keywords: Record<string, string[]> } | { error: string }}
 */
export function laneKeywords(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) {
    return { error: "lanes must name at least one lane" };
  }
  const keywords = {};
  for (const [id, v] of Object.entries(value)) {
    const list = words(v);
    // lanes.mjs loadLanes refuses a lane with no title keyword.
    if (!list?.length) return { error: `lane "${id}" needs at least one title keyword` };
    if (list.length > 40 || list.some((k) => k.length > 120)) {
      return { error: `lane "${id}" allows 40 keywords of at most 120 characters` };
    }
    keywords[id] = list;
  }
  return { keywords };
}

/**
 * The setIn edits for `keywords` against lanes.yml as plain data.
 * @param {Record<string, unknown>} current
 * @param {Record<string, string[]>} keywords
 * @returns {{ edits: [Array<string | number>, string[]][] } | { error: string }}
 */
export function laneEdits(current, keywords) {
  const lanes = Array.isArray(current?.lanes) ? current.lanes : [];
  const edits = [];
  for (const [id, list] of Object.entries(keywords)) {
    const i = lanes.findIndex((l) => l?.id === id);
    if (i < 0) return { error: `no lane "${id}" in config/lanes.yml` };
    edits.push([["lanes", i, "title_keywords"], list]);
  }
  return { edits };
}
