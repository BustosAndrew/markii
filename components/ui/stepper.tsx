import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

type StepState = "complete" | "current" | "upcoming";

export function Stepper({
  steps,
  className,
}: {
  steps: { id: string; label: string; description?: string; state: StepState }[];
  className?: string;
}) {
  return (
    <ol className={cn("flex flex-wrap gap-3", className)}>
      {steps.map((step, index) => {
        const isComplete = step.state === "complete";
        const isCurrent = step.state === "current";

        return (
          <li
            key={step.id}
            className={cn(
              "flex min-w-[180px] flex-1 items-start gap-3 rounded-[var(--radius-card)] border px-4 py-3",
              isCurrent
                ? "border-brand/30 bg-error-bg/40"
                : isComplete
                  ? "border-border bg-surface"
                  : "border-border bg-surface-elevated",
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                isCurrent
                  ? "border-brand bg-brand text-on-brand"
                  : isComplete
                    ? "border-border bg-surface text-foreground"
                    : "border-border bg-surface text-muted",
              )}
            >
              {isComplete ? <Check className="size-3.5" /> : index + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">
                {step.label}
              </span>
              {step.description ? (
                <span className="mt-1 block text-sm leading-5 text-muted">
                  {step.description}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
