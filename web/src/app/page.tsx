import { readApplications, readInbox, doctorState } from "@/lib/career-ops";
import { todaySnapshot } from "@/lib/home/today-snapshot.mjs";
import { homeData } from "@/lib/home/home-data";
import { scoreNum } from "@/lib/format";
import { OnboardingBanner } from "@/components/onboarding-banner";
import { OnboardingProgress } from "@/components/home/onboarding-progress";
import { FirstRunHome } from "@/components/home/first-run-home";
import { TodayDashboard } from "@/components/home/today-dashboard";

export const dynamic = "force-dynamic"; // always read fresh local files at request time (never at build — CI has no user data)

export default async function Home() {
  const snapshot = { applications: readApplications(), inbox: readInbox() };
  const { phase, onboardingNeeded } = doctorState(snapshot);
  // First run (truly empty install): the CV-upload takeover IS the home — value
  // before commitment. The full dashboard returns once they have a CV or any data.
  if (phase === "first-run") return <FirstRunHome />;

  const { applications } = todaySnapshot(snapshot, scoreNum);
  // Show the setup banner whenever ANY prereq is missing (mirrors the core
  // doctor.mjs), so a portals-missing user is nudged rather than told "all caught up".
  return (
    <>
      {onboardingNeeded && <OnboardingBanner />}
        {/* The growing-profile panel renders nothing once every prerequisite and
            personalization section is complete. */}
        <div className="mx-auto max-w-6xl px-4 pt-6 sm:px-6">
          <OnboardingProgress />
        </div>
        <TodayDashboard applications={applications} inBetween={phase === "in-between"} home={await homeData()} />
    </>
  );
}
