"use client";

import { useState } from "react";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { ComingSoon } from "@/components/ui/coming-soon";
import type { ReadinessReport } from "@/lib/api/readiness";

export function HealthPagePreview({
  report,
  planned = false,
  error,
}: {
  report: ReadinessReport | null;
  planned?: boolean;
  error?: string | null;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  if (planned) {
    return (
      <>
        <ComingSoon
          title="Health issues are planned"
          description="Issue detection, severity counts, and resolution actions will appear here when readiness APIs are live."
          apiSection="API §9 · Readiness issues and history"
          action={
            <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
              Preview issue drawer
            </Button>
          }
        />
        <PreviewDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      </>
    );
  }

  if (error) {
    return (
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <h2 className="text-base font-medium text-foreground">Health issues</h2>
        <p className="mt-2 text-sm leading-6 text-muted">{error}</p>
      </section>
    );
  }

  if (!report) {
    return (
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <h2 className="text-base font-medium text-foreground">Health issues</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          Configuration required before readiness signals can be displayed.
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-medium text-foreground">Open issues</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Readiness scoring is live, but detailed issue actions are still landing.
            </p>
          </div>
          <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
            View details
          </Button>
        </div>
      </section>
      <PreviewDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}

function PreviewDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Issue drawer preview"
      description="This drawer is wired now so the health table can open rich issue detail when API §9 lands."
      footer={
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <section className="rounded-[var(--radius-control)] border border-border bg-surface-elevated p-4">
          <p className="text-sm font-medium text-foreground">What will appear here</p>
          <ul className="mt-2 space-y-2 text-sm leading-6 text-muted">
            <li>Severity, affected fields, and evidence from the readiness API.</li>
            <li>Recommendations and expected impact for retrieval or checkout quality.</li>
            <li>Resolution actions once the backend supports issue state changes.</li>
          </ul>
        </section>
      </div>
    </Drawer>
  );
}
