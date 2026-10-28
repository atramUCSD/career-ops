// The read copy for the page: the snapshot the PC pushed, served as the gzip bytes it
// uploaded. Nothing is parsed or compressed here, so the response costs the Function
// almost no CPU however many postings it holds; no-transform keeps the edge from
// recompressing it (and from weakening the ETag when it does).
//
// The ETag is the snapshot's version, a hash of its JSON, so it moves only when the
// data does. pushed_at moves on every runner push and rides in a header on 200 and
// 304 alike, so the page learns how fresh the PC is without downloading the copy.
const META = `SELECT (SELECT version FROM snapshot WHERE id = 1) AS v,
                     (SELECT value FROM sync_meta WHERE key = 'pushed_at') AS p`;

export async function onRequestGet({ request, env }) {
  const m = await env.DB.prepare(META).first();
  const headers = { 'cache-control': 'no-store, no-transform', 'x-pushed-at': m?.p ?? '' };
  if (!m?.v) return Response.json({ rows: [] }, { headers });
  // If-None-Match compares weakly (RFC 9110), so W/"v" matches "v".
  if (request.headers.get('If-None-Match')?.replace(/^W\//, '') === `"${m.v}"`) {
    return new Response(null, { status: 304, headers: { ...headers, etag: `"${m.v}"` } });
  }
  // Version and body from one row, so the ETag always names the bytes sent.
  const s = await env.DB.prepare('SELECT version, body FROM snapshot WHERE id = 1').first();
  return new Response(Uint8Array.fromBase64(s.body), {
    encodeBody: 'manual',
    headers: { ...headers, etag: `"${s.version}"`, 'content-type': 'application/json', 'content-encoding': 'gzip' },
  });
}
