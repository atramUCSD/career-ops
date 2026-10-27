// The read copy for the page: every row plus the time of the last push, assembled
// by SQLite into one JSON string, so nothing is parsed here.
export async function onRequestGet({ env }) {
  const body = await env.DB.prepare(
    `SELECT json_object(
       'pushedAt', (SELECT value FROM sync_meta WHERE key = 'pushed_at'),
       'rows', (SELECT json_group_array(json_object('id', id, 'kind', kind, 'data', json(json))) FROM copy_rows)
     ) AS body`,
  ).first('body');
  return new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
