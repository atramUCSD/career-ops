"use client";

import { useEffect, useState } from "react";

type Profile = { name: string };

const OWNER = "";
const NEW = "\u0000new";

// Whose user layer the app shows. A switch reloads the page rather than
// resetting each provider: every provider's state was read from the previous
// profile's files, and a full reload is the one reset that cannot miss one.
export function ProfilePicker() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [active, setActive] = useState<string>(OWNER);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/profiles")
      .then((r) => r.json())
      .then((j) => {
        setProfiles(j.profiles ?? []);
        setActive(j.active ?? OWNER);
      })
      .catch(() => setProfiles([]));
  }, []);

  async function post(body: object, then: () => void) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      then();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (profiles === null) return null;

  return (
    <div className="space-y-1.5 px-1">
      <label htmlFor="co-profile" className="text-[10px] font-semibold uppercase tracking-wide text-faint">
        Profile
      </label>
      <select
        id="co-profile"
        value={creating ? NEW : active}
        disabled={busy}
        onChange={(e) => {
          const v = e.target.value;
          if (v === NEW) return setCreating(true);
          setCreating(false);
          post({ select: v === OWNER ? null : v }, () => window.location.reload());
        }}
        className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground max-sm:min-h-[44px]"
      >
        <option value={OWNER}>Me (owner)</option>
        {profiles.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
        <option value={NEW}>New profile from a resume…</option>
      </select>
      {creating && (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            // A new profile's first job is its CV: land on the page whose
            // upload writes it, now pointed at the new profile.
            post({ create: name.trim() }, () => window.location.assign("/cv"));
          }}
        >
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name, e.g. alex or me-design"
            pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}"
            aria-label="New profile name"
            className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-sm"
          />
          <button type="submit" disabled={busy} className="rounded-md bg-brand-soft px-2 py-1 text-sm text-brand-text">
            Create
          </button>
        </form>
      )}
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
