"use client";

import { useState } from "react";
import { ArrowRight, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { initials, postProfiles } from "@/components/profile-picker";
import type { ProfileCard } from "@/lib/home/home-data";
import { cn } from "@/lib/cn";
import { CountUp, Steps } from "./motion-bits";

// One card per data root. Switching reloads the page for the same reason the
// sidebar picker does: every panel below was read from the old profile's files.
export function ProfileCards({ profiles, active }: { profiles: ProfileCard[]; active: ProfileCard }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  async function post(body: object, then: () => void) {
    setBusy(true);
    setError(null);
    try {
      await postProfiles(body);
      then();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <section className="mt-10" aria-labelledby="profiles-h">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 id="profiles-h" className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">
          Profiles
        </h2>
        <span className="text-xs text-faint">Each has its own CV, scan, pipeline and digest</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
        {profiles.map((p) => (
          <article
            key={p.dir}
            className={cn(
              "flex flex-col rounded-2xl border bg-surface p-5",
              p.active ? "border-brand/60 ring-1 ring-brand/30" : "border-border",
            )}
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className={cn(
                  "grid size-10 shrink-0 place-items-center rounded-full text-xs font-semibold",
                  p.active ? "bg-brand text-brand-foreground" : "bg-brand-soft text-brand-text",
                )}
              >
                {p.name ? initials(p.label) : "ME"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="truncate font-medium text-foreground">{p.label}</h3>
                  {p.active && <Badge tone="good">Active</Badge>}
                </div>
                <p className="truncate text-xs text-muted">{p.roles || "No target roles yet"}</p>
                <code className="font-mono text-[11px] text-faint">{p.dir}</code>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-[11px] uppercase tracking-[0.14em] text-faint">Pending</dt>
                <dd className="font-semibold text-foreground">
                  <CountUp value={p.pending} />
                </dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-[0.14em] text-faint">Digest</dt>
                <dd className={cn("truncate", p.digest === "Off" || p.digest === "Not scheduled" ? "text-muted" : "text-foreground")}>
                  {p.digest}
                </dd>
              </div>
            </dl>
            <div className="mt-4">
              <div className="mb-1.5 flex justify-between text-[11px] text-faint">
                <span className="uppercase tracking-[0.14em]">Setup</span>
                <span className="tabular-nums">
                  {p.setup.ready} of {p.setup.total}
                </span>
              </div>
              <Steps done={p.setup.ready} total={p.setup.total} tone={p.setup.ready === p.setup.total ? "bg-good" : "bg-brand"} />
            </div>
            <div className="mt-4 border-t border-border pt-3 text-sm">
              {p.active ? (
                <span className="text-brand-text">Editing this profile</span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => post({ select: p.name }, () => window.location.reload())}
                  className="inline-flex items-center gap-1 text-foreground hover:text-brand-text disabled:cursor-wait max-sm:min-h-[44px]"
                >
                  Switch <ArrowRight className="size-3.5" />
                </button>
              )}
            </div>
          </article>
        ))}
        <div className="flex flex-col justify-center rounded-2xl border border-dashed border-border p-5">
          {creating ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                // A new profile's first job is its CV: land where the upload writes it.
                post({ create: name.trim() }, () => window.location.assign("/cv"));
              }}
              className="space-y-2"
            >
              <label htmlFor="home-new-profile" className="text-sm font-medium text-foreground">
                New profile name
              </label>
              <input
                id="home-new-profile"
                autoFocus
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. alex or me-design"
                pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}"
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
              />
              <div className="flex gap-2">
                <button type="submit" disabled={busy} className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-foreground">
                  Create and add CV
                </button>
                <button type="button" onClick={() => setCreating(false)} className="px-2 text-sm text-muted">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex flex-col items-center gap-2 py-6 text-sm text-muted hover:text-foreground"
            >
              <span className="grid size-10 place-items-center rounded-full border border-dashed border-border">
                <Plus className="size-4" />
              </span>
              New profile
              <span className="text-xs text-faint">Separate CV, scan and digest</span>
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-bad-text">
          {error}
        </p>
      )}
      <p className="mt-4 text-xs text-faint">
        Everything below applies to <span className="text-foreground">{active.label}</span> ·{" "}
        <code className="font-mono">{active.dir}</code>
      </p>
    </section>
  );
}
