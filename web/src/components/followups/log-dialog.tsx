"use client";

import { useId, useState } from "react";
import { CHANNELS, localISODate, type CadenceEntry, type Channel } from "@/lib/followups";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select, Textarea } from "@/components/ui/field";

// "Log" — the full-fidelity FollowUp entry (date, channel enum, contact,
// notes). Appends one table row via /api/followups/log.
export function LogDialog({
  entry,
  onClose,
  onLogged,
}: {
  entry: CadenceEntry;
  onClose: () => void;
  onLogged: () => void;
}) {
  // Local day, not UTC — east of UTC toISOString() defaults to "yesterday"
  // and its max would block picking the user's actual today.
  const [date, setDate] = useState(() => localISODate());
  const [channel, setChannel] = useState<Channel>("Email");
  const [contact, setContact] = useState(entry.contacts[0]?.email ?? "");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The footer sits outside the form in Dialog, so submit reaches it by form id.
  const formId = useId();

  // Keep free text single-line and pipe-free BEFORE it leaves the client
  // (the API's cell() normalizes again server-side — defense in depth): the
  // log is a pipe-delimited markdown table, so `|` and newlines would break
  // the row format.
  const tableSafe = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\|/g, "/").trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/followups/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appNum: entry.num,
          company: entry.company,
          role: entry.role,
          date,
          channel,
          contact: tableSafe(contact),
          notes: tableSafe(notes),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof j.error === "string" ? j.error : "Could not log the follow-up.");
        setSaving(false);
        return;
      }
      onLogged();
      onClose();
    } catch {
      setError("Could not log the follow-up.");
      setSaving(false);
    }
  };

  const optional = <span className="font-normal text-faint">(optional)</span>;

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title="Log follow-up"
      description={
        <>
          {entry.company} · {entry.role} <span className="text-faint">(#{entry.num})</span>
        </>
      }
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose} className="text-muted">
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            Log follow-up
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Date"
            type="date"
            required
            value={date}
            max={localISODate()}
            onChange={(e) => setDate(e.target.value)}
          />
          <Select label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>
        <Input
          label={<>Contact {optional}</>}
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          placeholder="who you reached out to"
          list={entry.contacts.length ? `co-contacts-${entry.num}` : undefined}
        />
        {entry.contacts.length > 0 && (
          <datalist id={`co-contacts-${entry.num}`}>
            {entry.contacts.map((c) => (
              <option key={c.email} value={c.email}>
                {c.name ?? undefined}
              </option>
            ))}
          </datalist>
        )}
        <Textarea
          label={<>Notes {optional}</>}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="what you said, what you're waiting on…"
          className="resize-none"
        />
        {error && (
          <p role="alert" className="text-xs text-bad-text">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
