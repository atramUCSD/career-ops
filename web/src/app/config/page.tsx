import { homeData } from "@/lib/home/home-data";
import { ConfigForm } from "@/components/config-form";
import { SettingsPanels } from "@/components/home/settings-panels";
import { SETTINGS_SECTIONS } from "@/lib/home/settings-sections";

export const dynamic = "force-dynamic"; // panels read the user's config files at request time

const SECTIONS = [...SETTINGS_SECTIONS, { id: "engine", label: "AI engine" }];

export default async function ConfigPage() {
  const home = await homeData();
  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-6 max-sm:pb-24 sm:px-6 sm:py-8">
      <header>
        <h1 className="font-display text-2xl tracking-tight text-landing">Config</h1>
        <p className="mt-1 text-sm text-muted">Settings for {home.active.label}: who gets the digest, what the scanner keeps, and which AI runs it.</p>
        {/* Same edge fade as the pipeline tabs: the row scrolls sideways on a phone. */}
        <nav
          aria-label="Config sections"
          className="mt-4 flex flex-nowrap gap-1 overflow-x-auto [scrollbar-width:none] max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)]"
        >
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="shrink-0 rounded-full border border-border px-3 py-1.5 text-sm whitespace-nowrap text-muted focus-ring transition-colors duration-150 ease-out hover:text-foreground max-sm:min-h-11 max-sm:py-2.5"
            >
              {s.label}
            </a>
          ))}
        </nav>
      </header>
      <SettingsPanels home={home} />
      <ConfigForm />
    </div>
  );
}
