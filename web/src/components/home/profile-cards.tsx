"use client";

import { useState } from "react";
import { ArrowRight, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { initials, postProfiles } from "@/components/profile-picker";
import type { ProfileCard } from "@/lib/home/home-data";
import { cn } from "@/lib/cn";
import { CountUp, Steps } from "@/components/ui/charts";

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
    <section aria-labelledby="profiles-h">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="profiles-h" className="eyebrow text-xs font-semibold text-muted">
          Profiles
        </h2>
        <span className="text-xs text-faint">Each has its own CV, scan, pipeline and digest</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
        {profiles.map((p) => (
          <Card as="article" key={p.dir} className={cn("flex flex-col", p.active && "border-brand/60 ring-1 ring-brand/30")}>
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
                  <h3 className="truncate text-sm font-semibold text-foreground">{p.label}</h3>
                  {p.active && <Badge tone="good">Active</Badge>}
                </div>
                <p className="truncate text-xs text-muted">{p.roles || "No target roles yet"}</p>
                <code className="font-mono text-2xs text-faint">{p.dir}</code>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
              <div>
                <dt className="eyebrow text-2xs font-semibold text-muted">Pending</dt>
                <dd className="font-semibold text-foreground">
                  <CountUp value={p.pending} />
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="eyebrow text-2xs font-semibold text-muted">Digest</dt>
                <dd title={p.digest} className={cn("truncate", p.digest === "Off" || p.digest === "Not scheduled" ? "text-muted" : "text-foreground")}>
                  {p.digest}
                </dd>
              </div>
            </dl>
            <div className="mt-4">
              <div className="mb-1.5 flex justify-between text-2xs text-muted">
                <span className="eyebrow font-semibold">Setup</span>
                <span className="tabular-nums">
                  {p.setup.ready} of {p.setup.total}
                </span>
              </div>
              <Steps done={p.setup.ready} total={p.setup.total} tone={p.setup.ready === p.setup.total ? "good" : "brand"} />
            </div>
            <div className="mt-4 border-t border-border pt-3 text-sm">
              {p.active ? (
                <span className="text-brand-text">Editing this profile</span>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => post({ select: p.name }, () => window.location.reload())}
                  className="-ml-2 text-sm text-foreground hover:text-brand-text"
                  aria-label={`Switch to ${p.name}`}
                >
                  Switch <ArrowRight aria-hidden className="size-3.5" />
                </Button>
              )}
            </div>
          </Card>
        ))}
        <div className={cn("flex flex-col rounded-2xl border border-dashed border-border p-5", creating ? "justify-start" : "justify-center")}>
          {creating ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                // A new profile's first job is its CV: land where the upload writes it.
                post({ create: name.trim() }, () => window.location.assign("/cv"));
              }}
              className="space-y-3"
            >
              <Input
                id="home-new-profile"
                label="New profile name"
                autoFocus
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. sam or me-design"
                pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}"
                error={creating ? error : null}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={busy}>
                  Create and add CV
                </Button>
                <Button type="button" variant="ghost" onClick={() => setCreating(false)} className="text-muted">
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            // The whole dashed tile is the target, so this stays a bare button.
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex flex-col items-center gap-2 rounded-xl py-6 text-sm text-muted transition-colors duration-150 ease-out hover:text-foreground focus-ring"
            >
              <span aria-hidden className="grid size-10 place-items-center rounded-full border border-dashed border-border">
                <Plus className="size-4" />
              </span>
              New profile
              <span className="text-xs text-faint">Separate CV, scan and digest</span>
            </button>
          )}
        </div>
      </div>
      {error && !creating && (
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
