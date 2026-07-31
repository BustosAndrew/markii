"use client";

import { cn } from "@/lib/utils";

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  description,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  description?: string;
  id?: string;
}) {
  const toggleId = id ?? label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <label htmlFor={toggleId} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {description ? (
          <p className="mt-0.5 text-sm text-muted">{description}</p>
        ) : null}
      </div>
      <button
        id={toggleId}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-brand hover:bg-brand-hover" : "bg-border hover:bg-disabled",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-[var(--shadow-sm)] transition-transform",
            checked && "translate-x-5",
          )}
        />
      </button>
    </div>
  );
}
