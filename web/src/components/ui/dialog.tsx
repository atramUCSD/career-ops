"use client";

import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

// Native <dialog> + showModal(): the browser supplies the inert background,
// focus trap, top layer and focus return. Enter/exit fades live in
// globals.css (dialog.ui-dialog), with the scale step behind reduced motion.
const SIZES = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  // The height sits on the dialog, not the body: flex-1's 0% basis ignores a body
  // height, and a definite dialog height lets h-full children (the digest iframe) resolve.
  xl: "h-[85vh] max-w-3xl",
} as const;

export function Dialog({
  open,
  onClose,
  title,
  description,
  size = "md",
  footer,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  size?: keyof typeof SIZES;
  footer?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // A drag that starts inside and ends on the backdrop fires click on the
  // dialog itself; only a press that began on the backdrop closes.
  const pressedBackdrop = useRef(false);
  // Callers usually unmount the Dialog while it is still open, so close() never
  // runs and the browser skips its own focus return. Restore the opener by hand.
  const opener = useRef<HTMLElement | null>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
      // React's autoFocus fires at commit, while the dialog is still display:none,
      // and showModal() then picks the header close button. Refocus here instead:
      // a [data-autofocus] element, else the first field; no field keeps the native pick.
      (
        d.querySelector<HTMLElement>("[data-autofocus]") ??
        d.querySelector<HTMLElement>("textarea, input:not([type=hidden]), select")
      )?.focus();
    } else if (!open) {
      if (d.open) d.close();
      const el = opener.current;
      opener.current = null;
      if (el) queueMicrotask(() => el.isConnected && el.focus());
    }
  }, [open]);

  useLayoutEffect(() => {
    const d = ref.current;
    return () => {
      const el = opener.current;
      // Checked after the commit: StrictMode's simulated unmount leaves the dialog
      // connected and open, and must keep the opener for the real close.
      if (el)
        queueMicrotask(() => {
          if (d?.isConnected) return;
          opener.current = null;
          if (el.isConnected) el.focus();
        });
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      // Escape closes natively (Chrome may skip a cancelable cancel event on a
      // repeat press), so the close event is the one place that syncs state.
      onClose={() => open && onClose()}
      onPointerDown={(e) => (pressedBackdrop.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) onClose();
      }}
      className={cn(
        "ui-dialog m-auto w-[calc(100%-2rem)] flex-col rounded-2xl border border-border bg-surface p-0 text-foreground shadow-overlay open:flex",
        SIZES[size],
        className,
      )}
    >
      <div className="flex items-start gap-4 px-5 pt-5">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-base font-semibold text-foreground">
            {title}
          </h2>
          {description && (
            <p id={descId} className="mt-1 text-sm text-muted">
              {description}
            </p>
          )}
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close" className="-mt-1 -mr-1 text-muted">
          <X aria-hidden className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
    </dialog>
  );
}
