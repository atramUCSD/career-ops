// Runner-only push. The PC sends the version of the snapshot it built (a hash of the
// JSON) in x-copy-version, and the snapshot itself (gzipped JSON as base64 text) only
// when the server answered with a different version. The body is bound as is and
// never parsed, so a push costs the Function no CPU however big the copy is.
// Every call bumps pushed_at, the page's staleness clock, and returns the version the
// server now holds.

const UPSERT = `INSERT INTO snapshot (id, version, body) VALUES (1, ?1, ?2)
  ON CONFLICT(id) DO UPDATE SET version = excluded.version, body = excluded.body, updated_at = excluded.updated_at`;
const STAMP = `INSERT INTO sync_meta (key, value) VALUES ('pushed_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;

export async function onRequestPost({ request, env, data }) {
  if (!data.who.runner) return Response.json({ error: 'runner only' }, { status: 403 });
  const version = request.headers.get('x-copy-version') ?? '';
  if (!/^[0-9a-f]{16,64}$/.test(version)) return Response.json({ error: 'x-copy-version must be a hex hash' }, { status: 400 });
  const body = await request.text();
  // One batch is one transaction: the body, its version and the stamp land together.
  const results = await env.DB.batch([
    ...(body ? [env.DB.prepare(UPSERT).bind(version, body)] : []),
    env.DB.prepare(STAMP),
    env.DB.prepare('SELECT version FROM snapshot WHERE id = 1'),
  ]);
  return Response.json({ version: results.at(-1).results[0]?.version ?? null });
}
