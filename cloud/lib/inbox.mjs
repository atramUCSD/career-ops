// Shape check for page actions, shared by the inbox Function and cloud/check.mjs.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Same rule the runner enforces against states.yml; checked here too so junk never queues.
const STATE = /^[^|*\r\n]{1,40}$/;
const ROW = /^\d{1,6}$/;

/** The action as stored, or an error string. Shape only; the runner owns meaning. */
export function parseAction(body) {
  const { uuid, type, payload, precondition } = body ?? {};
  if (typeof uuid !== 'string' || !UUID.test(uuid)) return 'uuid must be a lowercase UUID';
  if (!ROW.test(String(payload?.n ?? ''))) return 'payload.n must be a tracker row number';
  const n = String(payload.n);
  if (type === 'move') {
    if (!STATE.test(String(payload.to ?? '')) || !STATE.test(String(precondition?.from ?? ''))) {
      return 'a move needs payload.to and precondition.from as state names';
    }
    return { uuid, type, payload: { n, to: payload.to }, precondition: { from: precondition.from } };
  }
  if (type === 'comment') {
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text || text.length > 2000) return 'a comment needs 1 to 2000 characters of text';
    return { uuid, type, payload: { n, text }, precondition: null };
  }
  return 'type must be move or comment';
}
