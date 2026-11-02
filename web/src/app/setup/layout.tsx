import type { ReactNode } from "react";
import { GET } from "@/app/api/setup/route";
import { coreModule, doctorState, readApplications, readInbox, userRoot } from "@/lib/career-ops";
import { homeData } from "@/lib/home/home-data";
import { SetupWizard } from "@/components/setup/setup-wizard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The wizard lives in the layout so it survives navigation between stages:
// /setup/<stage> only changes the selected segment, and the camera flies.
export default async function SetupLayout({ children }: { children: ReactNode }) {
  const [setup, home] = await Promise.all([GET().then((r) => r.json()), homeData()]);
  const applications = readApplications();
  const { hasCv } = doctorState({ applications, inbox: readInbox(applications) });

  // The same scores the alert filters, so the How picky preview counts what the email would send.
  let scores: number[];
  try {
    const { buildModel } = await coreModule<{ buildModel: (o: { root: string }) => { rows: { cb: number }[] } }>("build-artifact");
    scores = buildModel({ root: userRoot() }).rows.map((r) => r.cb).filter(Number.isFinite);
  } catch {
    scores = [];
  }
  // ponytail: scores rebuilt per request; cache if slow

  return (
    <SetupWizard setup={setup} hasCv={hasCv} scores={scores} schedule={home.schedule} gmailMissing={home.gmailMissing} persona={home.active.label}>
      {children}
    </SetupWizard>
  );
}
