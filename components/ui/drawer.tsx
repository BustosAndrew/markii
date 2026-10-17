"use client";

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  keepMounted,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  /**
   * Hide rather than unmount when closed, so the children keep their state —
   * a chat whose transcript and in-flight stream live in a hook would
   * otherwise lose both on every close.
   */
  keepMounted?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Only the topmost dialog answers Escape. A confirm opened from inside
      // the drawer, or the step-up modal over it, closes itself — not this.
      const modals = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (modals[modals.length - 1] !== sectionRef.current) return;
      onClose();
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open && !keepMounted) {
    return null;
  }

  return (
    <div className={cn("fixed inset-0 z-50 justify-end", open ? "flex" : "hidden")}>
      <button
        type="button"
        className="absolute inset-0 bg-foreground/20 backdrop-blur-[1px]"
        aria-label="Close drawer"
        onClick={onClose}
      />
      <section
        ref={sectionRef}
        role="dialog"
        // A hidden, kept-mounted drawer must not count as a modal on top.
        aria-modal={open ? "true" : undefined}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          "relative flex h-full w-full max-w-xl flex-col border-l border-border bg-surface shadow-[var(--shadow-md)]",
          className,
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-sm leading-6 text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            className="size-9 rounded-full px-0 py-0"
            onClick={onClose}
            aria-label="Close drawer"
          >
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>

        {footer ? (
          <footer className="border-t border-border px-6 py-4">{footer}</footer>
        ) : null}
      </section>
    </div>
  );
}
