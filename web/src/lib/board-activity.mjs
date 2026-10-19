// Card detail and activity timeline for the /board side panel.
//
// Every source here is a file some other writer already owns (report, status
// ledger, scan history, expired-jobs log); this module only reads and merges
// them. The one file the board writes itself, data/board-activity.jsonl, holds
// what no other source records: comments, opens, and moves with a time of day
// (the status ledger stores the date only). Pure JS so
// tests/lib/board-activity.test.mjs can import it.

import YAML from "yaml";
import { canonStatus } from "./status-alias.mjs";

/**
 * @typedef {{ at: string, kind: string, title: string, detail?: string, dated?: boolean }} TimelineEvent
 *   `dated` marks a date-only source: the UI prints the day, never a fake midnight.
 * @typedef {{ at: string, n: string, kind: "comment" | "move" | "open", text?: string, from?: string, to?: string }} BoardEvent
 */

/**
 * The `**Key:** value` header lines and the Machine Summary YAML of a report.
 * A report that predates the summary, or carries broken YAML, yields
 * `summary: null` rather than throwing: the panel still has the header.
 * @param {string} content
 */
export function parseReportMeta(content) {
  /** @type {Record<string, string>} */
  const header = {};
  for (const line of (content ?? "").split(/\r?\n/)) {
    if (line.startsWith("## ")) break;
    const m = /^\*\*([^*:]+):\*\*\s*(.+)$/.exec(line.trim());
    if (m) header[m[1].trim()] = m[2].trim();
  }
  let summary = null;
  const block = /##\s+Machine Summary\s*\n+```ya?ml\n([\s\S]*?)\n```/.exec(content ?? "");
  if (block) {
    try {
      const parsed = YAML.parse(block[1]);
      if (parsed && typeof parsed === "object") summary = parsed;
    } catch {
      // keep the header; a malformed summary is the core's bug, not the panel's
    }
  }
  return { header, summary };
}

/**
 * Rows of data/status-log.tsv for one tracker number.
 * @param {string} tsv
 * @param {string} n
 */
export function parseStatusLog(tsv, n) {
  const rows = [];
  for (const line of (tsv ?? "").split(/\r?\n/)) {
    const [num, date, from, to, source] = line.split("\t");
    if (num === n && /^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) rows.push({ date, from, to, source: source ?? "" });
  }
  return rows;
}

/**
 * First sighting of a posting in data/scan-history.tsv (url, first_seen, portal).
 * @param {string} tsv
 * @param {string} url
 */
export function scanSighting(tsv, url) {
  if (!url) return null;
  const line = (tsv ?? "").split(/\r?\n/).find((l) => l.startsWith(`${url}\t`));
  if (!line) return null;
  const [, date, portal] = line.split("\t");
  return /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? { date, portal: portal ?? "" } : null;
}

/**
 * Date a liveness check confirmed the posting gone, from data/expired-jobs.md
 * (`| Removed (est.) | ... | URL |`, URL in the last cell).
 * @param {string} md
 * @param {string} url
 */
export function expiredOn(md, url) {
  if (!url) return null;
  for (const line of (md ?? "").split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.at(-1) === url && /^\d{4}-\d{2}-\d{2}$/.test(cells[0])) return cells[0];
  }
  return null;
}

/** Local calendar day of an ISO timestamp: the ledger's dates are local too. */
export function localDay(iso) {
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Merge every source into one newest-first timeline.
 *
 * A board move also lands in the status ledger (source "web"), so a ledger row
 * is dropped when a board move on the same day reached the same state; the
 * board's copy wins because it carries a time. Ledger rows from the CLI or any
 * other writer always show.
 * @param {{
 *   app: { date: string, status: string, score: string },
 *   ledger: ReturnType<typeof parseStatusLog>,
 *   sighting: ReturnType<typeof scanSighting>,
 *   expired: string | null,
 *   events: BoardEvent[],
 * }} input
 * @returns {TimelineEvent[]}
 */
export function buildTimeline({ app, ledger, sighting, expired, events }) {
  /** @type {TimelineEvent[]} */
  const out = [];
  const boardMoves = new Set(
    events.filter((e) => e.kind === "move").map((e) => `${localDay(e.at)}|${canonStatus(e.to ?? "")}`),
  );
  if (sighting) out.push({ at: sighting.date, dated: true, kind: "scan", title: "Found by scan", detail: sighting.portal || undefined });
  if (/^\d{4}-\d{2}-\d{2}$/.test(app.date)) {
    out.push({ at: app.date, dated: true, kind: "evaluated", title: "Evaluated", detail: app.score || undefined });
  }
  for (const r of ledger) {
    if (boardMoves.has(`${r.date}|${canonStatus(r.to)}`)) continue;
    out.push({
      at: r.date,
      dated: true,
      kind: "status",
      title: `${r.from && r.from !== "-" ? r.from : "?"} → ${r.to}`,
      detail: r.source === "web" ? "web" : r.source,
    });
  }
  if (expired) out.push({ at: expired, dated: true, kind: "expired", title: "Posting removed", detail: "Liveness check" });
  for (const e of events) {
    if (e.kind === "comment") out.push({ at: e.at, kind: "comment", title: "Comment", detail: e.text });
    else if (e.kind === "move") out.push({ at: e.at, kind: "move", title: `${e.from ?? "?"} → ${e.to}`, detail: "Board" });
    else if (e.kind === "open") out.push({ at: e.at, kind: "open", title: "Opened card" });
  }
  // A date-only event sorts as the START of its day, so anything timestamped
  // that same day lands above it: "evaluated" before "moved to Applied".
  // Epoch ms, not string compare: board events are UTC ISO, ledger dates are local.
  const key = (e) => (e.dated ? new Date(`${e.at}T00:00:00`).getTime() : Date.parse(e.at));
  out.sort((a, b) => key(b) - key(a));
  // A run of opens with nothing in between is one browsing session in the log:
  // keep the newest, count the rest. The 30-minute server dedupe only catches
  // rapid reopens; this catches the days-apart ones too.
  const merged = [];
  let run = 0;
  for (const e of out) {
    const prev = merged.at(-1);
    if (e.kind === "open" && prev?.kind === "open") {
      run += 1;
      prev.title = `Opened ${run}×`;
      prev.detail = `since ${localDay(e.at)}`;
    } else {
      run = 1;
      merged.push(e);
    }
  }
  return merged;
}
