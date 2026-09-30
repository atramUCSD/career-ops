"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

// disc#9: remove a bogus tracker row (e.g. a job marked Evaluated after the CLI
// errored mid-run). Hard delete via the core write-gate (/api/tracker/delete →
// tracker.mjs delete), behind a confirm. The soft option (status → Discarded) lives
// in StatusSelect and stays for real-but-passed applications.
export function DeleteFromTracker({ n }: { n: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [orphan, setOrphan] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function openConfirm() {
    setOpen(true);
    setErr("");
    setOrphan(null);
    try {
      const r = await fetch("/api/tracker/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n, dryRun: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "This row can’t be removed.");
        return;
      }
      setOrphan(d.orphanReport ?? null);
    } catch {
      setErr("Couldn’t reach the tracker.");
    }
  }

  async function confirmDelete() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/tracker/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error || "Delete failed.");
        setBusy(false);
        return;
      }
      // Row is gone — leave the (now-orphaned) report page for the pipeline.
      router.push("/pipeline");
      router.refresh();
    } catch {
      setErr("Delete failed.");
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="danger-ghost" size="sm" onClick={openConfirm} className="border border-border hover:border-bad/50">
        <Trash2 aria-hidden className="size-3.5" /> Remove from tracker
      </Button>
    );
  }

  return (
    <Card inset tone="bad" role="group" aria-label={`Remove application #${n}`} className="text-xs">
      <p className="font-medium text-foreground">Permanently remove application #{n} from your tracker?</p>
      <p className="mt-1 text-muted">
        This can’t be undone.{orphan ? ` Its report file (${orphan}) is left on disk.` : ""}
      </p>
      {err && (
        <p role="alert" className="mt-1.5 text-bad-text">
          {err}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button variant="danger" size="sm" loading={busy} onClick={confirmDelete}>
          {!busy && <Trash2 aria-hidden className="size-3.5" />} Delete
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
