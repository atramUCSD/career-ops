// The read copy for the page: every row plus the time of the last push. SQLite
// builds the JSON and the Function only joins strings, so nothing is parsed here.
// D1 caps one value at 2 MB, so the rows come back as ~1 MB parts split on a
// running sum of their size rather than as one json_group_array.
//
// The ETag is copy_version, which /api/sync bumps only when rows change, while
// pushed_at moves on every run. An unchanged copy costs one sync_meta lookup and a
// 304 that still carries pushed_at, so the page learns how fresh the PC is without
// downloading every row again.
const META = `SELECT (SELECT value FROM sync_meta WHERE key = 'copy_version') AS v,
                     (SELECT value FROM sync_meta WHERE key = 'pushed_at') AS p`;
const PARTS = `SELECT group_concat(j, ',') AS part FROM (
  SELECT json_object('id', id, 'kind', kind, 'data', json(json)) AS j,
         sum(length(json) + 64) OVER (ORDER BY id) / 1000000 AS t
  FROM copy_rows
) GROUP BY t`;

export async function onRequestGet({ request, env }) {
  const asked = request.headers.get('If-None-Match');
  if (asked) {
    const m = await env.DB.prepare(META).first();
    if (m?.v && asked === `"${m.v}"`) {
      return new Response(null, { status: 304, headers: { etag: asked, 'x-pushed-at': m.p ?? '', 'cache-control': 'no-store' } });
    }
  }
  // A batch is one transaction, so the ETag and the rows come from the same snapshot.
  const [meta, parts] = await env.DB.batch([env.DB.prepare(META), env.DB.prepare(PARTS)]);
  const { v, p } = meta.results[0];
  const body = `{"pushedAt":${JSON.stringify(p)},"rows":[${parts.results.map((r) => r.part).join(',')}]}`;
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (v) headers.etag = `"${v}"`;
  return new Response(body, { headers });
}
