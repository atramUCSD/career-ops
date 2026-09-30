"use client";

import { useId } from "react";
import { cn } from "@/lib/cn";

// Form controls; ref is a plain prop (React 19). className lands on the control itself, like the native
// element it replaces; label, hint and error sit around it.

type FieldOwn = {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  meta?: React.ReactNode;
  /** Home settings panels only: the eyebrow label. */
  compact?: boolean;
};

const CONTROL =
  "w-full rounded-md border border-control-border bg-surface text-foreground placeholder:text-faint field-focus transition-colors duration-150 ease-out disabled:opacity-50";
const SIZES = { sm: "h-7 px-2 text-xs", md: "h-9 px-3 text-sm" } as const;

function Shell({
  id,
  label,
  hint,
  error,
  meta,
  compact,
  labelFor = true,
  children,
}: FieldOwn & { id: string; labelFor?: boolean; children: React.ReactNode }) {
  const LabelTag = labelFor ? "label" : "span";
  // Field wraps controls that label themselves; the group ties its label and hint to all of them.
  const group = labelFor
    ? undefined
    : {
        role: "group",
        "aria-labelledby": label ? `${id}-label` : undefined,
        "aria-describedby": error ? `${id}-error` : hint ? `${id}-hint` : undefined,
      };
  return (
    <div {...group}>
      {(label || meta) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          {label && (
            <LabelTag
              id={`${id}-label`}
              htmlFor={labelFor ? id : undefined}
              className={compact ? "eyebrow text-2xs font-semibold text-muted" : "text-sm font-medium text-foreground"}
            >
              {label}
            </LabelTag>
          )}
          {meta && <span className="ml-auto font-mono text-2xs text-faint">{meta}</span>}
        </div>
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-bad-text">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="mt-1.5 text-xs text-faint">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/** Wires id, aria-invalid and aria-describedby from the field's own props. */
function useFieldIds(own: FieldOwn, id: string | undefined, describedBy: string | undefined) {
  const auto = useId();
  const fid = id ?? auto;
  const note = own.error ? `${fid}-error` : own.hint ? `${fid}-hint` : undefined;
  return {
    id: fid,
    "aria-invalid": own.error ? true : undefined,
    "aria-describedby": [describedBy, note].filter(Boolean).join(" ") || undefined,
  };
}

export function Input({
  label,
  hint,
  error,
  meta,
  compact,
  size = "md",
  mono,
  id,
  className,
  "aria-describedby": describedBy,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & FieldOwn & { size?: "sm" | "md"; mono?: boolean }) {
  const own = { label, hint, error, meta, compact };
  const ids = useFieldIds(own, id, describedBy);
  return (
    <Shell {...own} id={ids.id}>
      <input {...props} {...ids} className={cn(CONTROL, SIZES[size], mono && "font-mono", className)} />
    </Shell>
  );
}

export function Textarea({
  label,
  hint,
  error,
  meta,
  compact,
  mono,
  id,
  className,
  "aria-describedby": describedBy,
  ...props
}: React.ComponentProps<"textarea"> & FieldOwn & { mono?: boolean }) {
  const own = { label, hint, error, meta, compact };
  const ids = useFieldIds(own, id, describedBy);
  return (
    <Shell {...own} id={ids.id}>
      <textarea {...props} {...ids} className={cn(CONTROL, "min-h-20 px-3 py-2 text-sm", mono && "font-mono", className)} />
    </Shell>
  );
}

export function Select({
  label,
  hint,
  error,
  meta,
  compact,
  size = "md",
  id,
  className,
  "aria-describedby": describedBy,
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & FieldOwn & { size?: "sm" | "md" }) {
  const own = { label, hint, error, meta, compact };
  const ids = useFieldIds(own, id, describedBy);
  return (
    <Shell {...own} id={ids.id}>
      <select {...props} {...ids} className={cn(CONTROL, SIZES[size], className)} />
    </Shell>
  );
}

/** Label, hint and error around a custom control such as ChipList, which labels itself. */
export function Field({ children, ...own }: FieldOwn & { children: React.ReactNode }) {
  const id = useId();
  return (
    <Shell {...own} id={id} labelFor={false}>
      {children}
    </Shell>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative h-6 w-11 shrink-0 rounded-full focus-ring disabled:opacity-50"
    >
      <span
        className={cn(
          "absolute inset-0 rounded-full transition-colors duration-150 ease-out",
          checked ? "bg-brand" : "bg-control-border",
        )}
      />
      <span
        className={cn(
          "absolute top-0.5 left-0 size-5 rounded-full bg-white shadow-raised motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-out",
          checked ? "translate-x-[1.375rem]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
