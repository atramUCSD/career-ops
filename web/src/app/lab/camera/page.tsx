import { notFound } from "next/navigation";
import { CameraLab } from "./camera-lab";

// Perf harness for the wizard camera (plan section 8). Open in dev; a
// production build serves it only with CAREER_OPS_LAB=1, read per request so
// the build never bakes the answer in.
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production" && process.env.CAREER_OPS_LAB !== "1") notFound();
  // ?r= tunes the ring radius from the harness without a rebuild.
  const r = Number((await searchParams).r) || 900;
  return <CameraLab r={r} />;
}
