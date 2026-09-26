import { activeProfile, careerOpsRoot, profilesModule, setActiveProfile } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The profile selector's backend. Listing and scaffolding are the core's
// profiles.mjs, so a profile made here is the same thing `node profiles.mjs new`
// makes, and the CLI can run against it.

export async function GET() {
  const mod = await profilesModule();
  return Response.json({
    active: activeProfile(),
    profiles: mod.listProfiles().map((name) => mod.describe(name)),
  });
}

/** `{select: name | null}` switches (null = the owner); `{create: name}` scaffolds and switches. */
export async function POST(req: Request) {
  let body: { select?: string | null; create?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    if (typeof body.create === "string") {
      const mod = await profilesModule();
      if (!mod.validName(body.create)) {
        return Response.json({ error: "Use letters, digits, dot, dash or underscore (max 64)." }, { status: 400 });
      }
      if (mod.listProfiles().includes(body.create)) {
        return Response.json({ error: `A profile named "${body.create}" already exists.` }, { status: 409 });
      }
      mod.scaffold(body.create, { root: careerOpsRoot() });
      setActiveProfile(body.create);
    } else if (body.select === null || typeof body.select === "string") {
      setActiveProfile(body.select);
    } else {
      return Response.json({ error: "expected {select} or {create}" }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  return Response.json({ active: activeProfile() });
}
