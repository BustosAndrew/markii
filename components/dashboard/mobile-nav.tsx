"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import {
  SidebarBrand,
  SidebarNav,
  SidebarOrgCard,
  useCurrentSection,
} from "@/components/dashboard/sidebar";

const PANEL_ID = "dashboard-mobile-nav";

/**
 * Mobile dashboard shell: a sticky bar with a hamburger, plus a slide-in drawer
 * holding the same nav the desktop rail renders. Hidden at `lg` and up.
 */
export function MobileNav() {
  const pathname = usePathname();
  const section = useCurrentSection();
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Openness is derived, not stored: we remember the route the drawer was
  // opened on, so navigating away closes it in the same render rather than in a
  // follow-up effect that would paint the new page with the drawer still over it.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;

  const close = useCallback(() => setOpenedOn(null), []);

  // A resize past the `lg` breakpoint reveals the desktop rail; a drawer left
  // open behind it would trap scroll with no visible way to dismiss it.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setOpenedOn(null);
    };
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    const trigger = triggerRef.current;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;

      // Keep focus inside the drawer while it is modal.
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [open, close]);

  return (
    <>
      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur-md lg:hidden">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpenedOn(pathname)}
          aria-label="Open navigation menu"
          aria-expanded={open}
          aria-controls={PANEL_ID}
          className="-ml-2 flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-control)] text-foreground transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/10"
        >
          <Menu className="size-5" />
        </button>
        <SidebarBrand className="shrink-0" />
        <span className="ml-auto truncate text-sm font-medium text-muted">
          {section}
        </span>
      </header>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={close}
            className="absolute inset-0 animate-fade-in bg-foreground/30 backdrop-blur-[2px]"
          />
          <div
            id={PANEL_ID}
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Dashboard navigation"
            tabIndex={-1}
            className="animate-slide-in-left relative flex h-dvh w-[17rem] max-w-[85vw] flex-col border-r border-border bg-surface shadow-[var(--shadow-md)] focus:outline-none"
          >
            <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-nav px-4">
              <SidebarBrand />
              <button
                type="button"
                onClick={close}
                aria-label="Close navigation menu"
                className="-mr-2 flex size-10 cursor-pointer items-center justify-center rounded-[var(--radius-control)] text-muted transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/10"
              >
                <X className="size-5" />
              </button>
            </div>

            <SidebarNav
              onNavigate={close}
              className="min-h-0 flex-1 overflow-y-auto p-3"
            />

            <div className="shrink-0 border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <SidebarOrgCard />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
