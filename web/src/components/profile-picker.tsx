"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";

type Profile = { name: string; pending: number };

const OWNER = "";
const NEW = "\u0000new";

/** "vivian-chiong" -> "VC", "alex" -> "AL". */
export function initials(name: string): string {
  const parts = name.split(/[-._\s]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}

/** POST /api/profiles ({select} or {create}); throws the server's error. */
export async function postProfiles(body: object): Promise<void> {
  const r = await fetch("/api/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
}

// Whose user layer the app shows. A switch reloads the page rather than
// resetting each provider: every provider's state was read from the previous
// profile's files, and a full reload is the one reset that cannot miss one.
export function ProfilePicker() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [active, setActive] = useState<string>(OWNER);
  const [ownerPending, setOwnerPending] = useState(0);
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
        setOwnerPending(j.owner?.pending ?? 0);
      })
      .catch(() => setProfiles([]));
  }, []);

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

  if (profiles === null) return null;
  const current = profiles.find((p) => p.name === active);

  return (
    <div className="space-y-1.5">
      {/* The native select sits invisibly over the card: the OS picker, keyboard
          and screen-reader behaviour come free, and the card is its face. */}
      <div title="Own scan" className="relative flex items-center gap-2.5 rounded-md border border-control-border bg-surface px-2.5 py-2 field-focus-within transition-colors duration-150 ease-out hover:bg-surface-muted max-sm:min-h-11">
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-2xs font-semibold text-brand-text"
        >
          {current ? initials(current.name) : "ME"}
        </span>
        <span aria-hidden className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{current ? current.name : "Me (owner)"}</span>
          <span className="block truncate text-xs text-faint">
            {(current ? current.pending : ownerPending).toLocaleString()} pending
          </span>
        </span>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-faint" />
        <label htmlFor="co-profile" className="sr-only">
          Profile
        </label>
        <Select
          id="co-profile"
          value={creating ? NEW : active}
          disabled={busy}
          onChange={(e) => {
            const v = e.target.value;
            if (v === NEW) return setCreating(true);
            setCreating(false);
            post({ select: v === OWNER ? null : v }, () => window.location.reload());
          }}
          // The card face above draws border and focus; the control itself stays an invisible hit area.
          className="absolute inset-0 size-full cursor-pointer border-0 opacity-0 disabled:cursor-wait"
        >
          <option value={OWNER}>Me (owner)</option>
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
          <option value={NEW}>New profile from a resume…</option>
        </Select>
      </div>
      {creating && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            // A new profile's first job is its CV: land on the page whose
            // upload writes it, now pointed at the new profile.
            post({ create: name.trim() }, () => window.location.assign("/cv"));
          }}
        >
          <div className="min-w-0 flex-1">
            <Input
              size="sm"
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name, e.g. alex or me-design"
              pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}"
              aria-label="New profile name"
            />
          </div>
          <Button type="submit" variant="soft" size="sm" loading={busy}>
            Create
          </Button>
        </form>
      )}
      {error && <p role="alert" className="text-xs text-bad-text">{error}</p>}
    </div>
  );
}
