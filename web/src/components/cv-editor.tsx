"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/field";

export function CvEditor() {
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [exists, setExists] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/cv")
      .then((r) => r.json())
      .then((d) => {
        setContent(d.content ?? "");
        setExists(d.exists ?? false);
      })
      .finally(() => setLoaded(true));
  }, []);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/cv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        setDirty(false);
        setExists(true);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8 max-sm:pb-24">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">CV editor</h1>
          <p className="mt-1 text-sm text-muted">
            Edit <code className="text-foreground">cv.md</code> with live preview.
            {!exists && loaded && <span className="ml-1 text-faint">No cv.md yet — start typing to create it.</span>}
          </p>
        </div>
        <Button
          type="button"
          variant={dirty ? "primary" : "secondary"}
          onClick={save}
          loading={saving}
          disabled={!dirty}
        >
          {saved && !saving && <Check aria-hidden className="size-4" />}
          {saved ? "Saved" : "Save"}
        </Button>
      </div>

      {!loaded ? (
        // Same grid and pane heights as the loaded state, so the page does not jump when /api/cv resolves.
        <div className="grid gap-4 lg:grid-cols-2">
          <div aria-busy className="min-h-[60vh] lg:h-[70vh] rounded-2xl border border-border bg-surface/50 p-5 text-sm text-muted">
            Loading…
          </div>
          <div aria-busy className="min-h-[60vh] lg:h-[70vh] rounded-2xl border border-border bg-surface/50" />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Editor pane keeps the preview's surface radius and padding so the pair reads as one split view. */}
          <Textarea
            aria-label="cv.md source"
            mono
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setDirty(true);
            }}
            spellCheck={false}
            placeholder="# Your Name&#10;&#10;## Summary&#10;..."
            className="min-h-[60vh] lg:h-[70vh] resize-none rounded-2xl bg-surface/50 p-5 leading-relaxed"
          />
          <Card
            as="article"
            tabIndex={0}
            aria-label="cv.md preview"
            className="report-prose min-h-[60vh] lg:h-[70vh] overflow-auto bg-surface/50 focus-ring"
          >
            {content.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            ) : (
              <p className="text-muted">Preview appears here.</p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
