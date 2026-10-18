import path from "node:path";
import { PortalsView } from "@/components/portals-view";
import { careerOpsRoot, portalsConfigPath, userRoot } from "@/lib/career-ops";
import { watchedCompanies, type WatchedCompany } from "@/lib/portals-config.mjs";
import { loadYamlDoc } from "@/lib/yaml-doc.mjs";

export const dynamic = "force-dynamic";

function readWatched(): { watched: WatchedCompany[]; error: string | null } {
  // The active profile's file, seeded from the code root's shipped example.
  try {
    const { doc, seeded } = loadYamlDoc(portalsConfigPath(userRoot()), path.join(careerOpsRoot(), "templates", "portals.example.yml"));
    return { watched: seeded ? [] : watchedCompanies(doc.toJS()), error: null };
  } catch (e) {
    return { watched: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export default function PortalsPage() {
  const { watched, error } = readWatched();
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 max-sm:pb-24">
      <div className="mb-6">
        <h1 className="font-display text-2xl tracking-tight text-landing">Portals</h1>
        <p className="mt-1.5 max-w-xl text-sm text-muted">
          The companies career-ops watches for new roles. Run a health check to catch company boards that have quietly
          broken — a broken link means that company silently disappears from every future scan.
        </p>
        <p className="mt-1.5 text-xs text-faint">
          Backed by <code className="text-muted">portals.yml</code> — edit it directly or ask the assistant.
        </p>
      </div>
      {error && (
        <p role="alert" className="mb-4 rounded-xl border border-bad/40 bg-bad/10 p-3 text-sm text-bad-text">
          Could not read <code>portals.yml</code>: {error}
        </p>
      )}
      <PortalsView watched={watched} />
    </div>
  );
}
