import type { SetupChecklist, SetupStep, StoreSetup } from "@/lib/api/setup";
import { AskAgentButton, AskAssistantButton } from "@/components/dashboard/ask-assistant-button";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";

function statusTone(status: SetupStep["status"]): "live" | "draft" | "paused" {
  if (status === "done") return "live";
  if (status === "not_needed") return "draft";
  return "paused";
}

function statusLabel(status: SetupStep["status"]): string {
  if (status === "done") return "Done";
  if (status === "not_needed") return "Not needed";
  return "To do";
}

function StepActions({ step }: { step: SetupStep }) {
  if (step.status === "done" || step.status === "not_needed") return null;

  if (!step.canAct) {
    return <p className="text-sm leading-6 text-muted">Ask an owner or administrator.</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ButtonLink href={step.href} className="px-3 py-1.5 text-sm">
        Continue
      </ButtonLink>
      {step.agent === "catalog" ? (
        <AskAgentButton agent="catalog" label="Ask the Catalog agent" />
      ) : null}
      {step.agent === "assistant" ? <AskAssistantButton /> : null}
    </div>
  );
}

function StepRow({ step, headline = false }: { step: SetupStep; headline?: boolean }) {
  return (
    <li className={headline ? "space-y-3" : "space-y-2 py-3"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">{step.title}</p>
            {!step.required ? <Badge variant="neutral">Recommended</Badge> : null}
          </div>
          <p className="mt-1 text-sm leading-6 text-muted">{step.detail}</p>
        </div>
        <StatusDot tone={statusTone(step.status)} label={statusLabel(step.status)} />
      </div>
      <StepActions step={step} />
    </li>
  );
}

function StoreBlock({ store }: { store: StoreSetup }) {
  return (
    <section>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{store.name}</h3>
        <p className="text-sm text-muted">
          {store.readyToLaunch
            ? "Ready to go live"
            : store.requiredRemaining === 1
              ? "1 required step left"
              : `${store.requiredRemaining} required steps left`}
        </p>
      </div>
      <ul className="divide-y divide-border">
        {store.steps.map((step) => (
          <StepRow key={`${store.siteId}:${step.id}`} step={step} />
        ))}
      </ul>
    </section>
  );
}

export function SetupChecklistCard({ checklist }: { checklist: SetupChecklist }) {
  if (checklist.complete) return null;

  const next = checklist.next;

  if (!checklist.firstRun) {
    if (!next) return null;
    return (
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-foreground">Next up</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              {next.siteId === null
                ? "An account step is still open."
                : "One step still helps this store."}
            </p>
          </div>
          <AskAssistantButton />
        </div>
        <ul>
          <StepRow step={next.step} headline />
        </ul>
      </section>
    );
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">Set up your store</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            This list is read from your store, not ticked off by hand. Finish a
            step and it will update on the next visit.
          </p>
        </div>
        <AskAssistantButton />
      </div>

      <div className="mt-6 space-y-6">
        <section>
          <h3 className="mb-1 text-sm font-medium text-foreground">Account</h3>
          <ul className="divide-y divide-border">
            {checklist.account.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </ul>
        </section>

        {checklist.stores.map((store) => (
          <StoreBlock key={store.siteId} store={store} />
        ))}
      </div>
    </section>
  );
}

export function SetupChecklistError({ message }: { message: string }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <h2 className="text-base font-medium text-foreground">Set up your store</h2>
      <p className="mt-2 text-sm leading-6 text-muted">{message}</p>
    </section>
  );
}