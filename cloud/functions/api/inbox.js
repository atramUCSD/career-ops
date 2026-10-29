// ADR-001 steps 5 and 7: the page's only write. People POST actions; the runner GETs
// the open ones and PUTs outcomes. Status is the cursor: an action stays open until
// the runner acknowledges a final status, so a runner that dies between applying and
// acknowledging sees the action again and replays its outcome from inbox-log.jsonl.
// Moves and comments go pending -> applied | rejected. Jobs go pending -> queued ->
// running -> done | failed, or straight to rejected over the daily cap.

import { parseAction, UUID } from '../../lib/inbox.mjs';

const STATUSES = ['applied', 'rejected', 'queued', 'running', 'done', 'failed'];

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const actions = (where, order, limit) => `SELECT json_group_array(json_object(
    'seq', seq, 'uuid', uuid, 'type', type, 'payload', json(payload), 'precondition', json(precondition),
    'sender', sender, 'status', status, 'result', json(result), 'createdAt', created_at, 'resolvedAt', resolved_at)) AS a
  FROM (SELECT * FROM inbox WHERE ${where} ORDER BY seq ${order} LIMIT ${limit})`;

// People see their recent actions (pending ones draw on the card, settled ones
// show their outcome); the runner sees the queue, oldest first.
export async function onRequestGet({ env, data }) {
  const sql = data.who.runner ? actions("status IN ('pending', 'queued', 'running')", 'ASC', 100) : actions('1', 'DESC', 50);
  return new Response(await env.DB.prepare(sql).first('a'), { headers: JSON_HEADERS });
}

export async function onRequestPost({ request, env, data }) {
  if (!data.who.email) return Response.json({ error: 'people only' }, { status: 403 });
  const action = parseAction(await request.json().catch(() => null));
  if (typeof action === 'string') return Response.json({ error: action }, { status: 400 });
  // A retried POST (flaky phone network) reuses its uuid and lands on the same row.
  await env.DB.prepare(
    `INSERT INTO inbox (uuid, type, payload, precondition, sender) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(uuid) DO NOTHING`,
  ).bind(action.uuid, action.type, JSON.stringify(action.payload), action.precondition && JSON.stringify(action.precondition), data.who.email).run();
  const row = await env.DB.prepare(actions('uuid = ?1', 'ASC', 1)).bind(action.uuid).first('a');
  return new Response(JSON.stringify(JSON.parse(row)[0]), { status: 201, headers: JSON_HEADERS });
}

export async function onRequestPut({ request, env, data }) {
  if (!data.who.runner) return Response.json({ error: 'runner only' }, { status: 403 });
  const { results } = (await request.json().catch(() => null)) ?? {};
  if (!Array.isArray(results) || results.some((r) => !UUID.test(r?.uuid ?? '') || !STATUSES.includes(r.status))) {
    return Response.json({ error: `results must be [{uuid, status: ${STATUSES.join('|')}, result}]` }, { status: 400 });
  }
  // A final status never changes, so a replayed acknowledgement never rewrites an outcome.
  const { meta } = await env.DB.prepare(
    `UPDATE inbox SET status = json_extract(r.value, '$.status'), result = json(json_extract(r.value, '$.result')),
       resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     FROM json_each(?1) AS r
     WHERE inbox.uuid = json_extract(r.value, '$.uuid') AND inbox.status IN ('pending', 'queued', 'running')`,
  ).bind(JSON.stringify(results.map(({ uuid, status, result }) => ({ uuid, status, result: result ?? {} })))).run();
  return Response.json({ settled: meta.changes });
}
