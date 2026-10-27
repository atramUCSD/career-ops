import { identify, localDevIdentity, verifyAccessJwt } from '../../lib/access.mjs';

// Every /api route needs a verified Access identity. Static pages skip Functions
// entirely and rely on Access at the edge.
export async function onRequest({ request, env, data, next }) {
  const claims = await verifyAccessJwt(request.headers.get('Cf-Access-Jwt-Assertion'), {
    teamDomain: env.TEAM_DOMAIN,
    aud: env.POLICY_AUD,
  });
  const who = (claims && identify(claims, { people: env.PEOPLE, runnerId: env.RUNNER_CLIENT_ID }))
    || localDevIdentity(request, env.LOCAL_DEV_IDENTITY);
  if (!who) return Response.json({ error: 'forbidden' }, { status: 403 });
  data.who = who;
  return next();
}
