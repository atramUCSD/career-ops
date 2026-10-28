// Runner-only push endpoint. GET returns {id: hash} so the PC can diff; POST applies
// the diff. The whole rowset goes in as one bound JSON parameter read with json_each,
// which keeps each request at three statements however many rows changed.

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

const UPSERT = `INSERT INTO copy_rows (id, kind, hash, json, updated_at)
  SELECT json_extract(value, '$.id'), json_extract(value, '$.kind'), json_extract(value, '$.hash'),
         json_extract(value, '$.json'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM json_each(?1) WHERE true
  ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, hash = excluded.hash, json = excluded.json, updated_at = excluded.updated_at`;

const forbidden = (data) => (data.who.runner ? null : Response.json({ error: 'runner only' }, { status: 403 }));

export async function onRequestGet({ env, data }) {
  return (
    forbidden(data) ??
    // ponytail: one value, so D1's 2 MB cap is reached near 17k rows (~120 B each);
    // split it like copy.js does if the copy grows past that.
    new Response(await env.DB.prepare('SELECT json_group_object(id, hash) AS h FROM copy_rows').first('h'), { headers: JSON_HEADERS })
  );
}

export async function onRequestPost({ request, env, data }) {
  const denied = forbidden(data);
  if (denied) return denied;
  const { upserts = [], deletes = [] } = await request.json();
  // One batch is one transaction; the pushed_at bump is the page's staleness clock.
  // copy_version is the ETag of /api/copy, so it moves only when a row did.
  const stamp = (key) =>
    env.DB.prepare(
      `INSERT INTO sync_meta (key, value) VALUES ('${key}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
  await env.DB.batch([
    env.DB.prepare(UPSERT).bind(JSON.stringify(upserts)),
    env.DB.prepare('DELETE FROM copy_rows WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(deletes)),
    stamp('pushed_at'),
    ...(upserts.length || deletes.length ? [stamp('copy_version')] : []),
  ]);
  return Response.json({ upserted: upserts.length, deleted: deletes.length });
}
