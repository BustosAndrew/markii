import { cn } from "@/lib/utils";

type TimelineTone = "default" | "success" | "warning" | "error" | "info";

const toneClasses: Record<TimelineTone, string> = {
  default: "bg-border",
  success: "bg-success-text",
  warning: "bg-warning-text",
  error: "bg-error-text",
  info: "bg-info-text",
};

export function Timeline({
  events,
  className,
}: {
  events: {
    id: string;
    title: string;
    description?: string;
    timestamp?: string;
    tone?: TimelineTone;
  }[];
  className?: string;
}) {
  return (
    <ol className={cn("space-y-4", className)}>
      {events.map((event) => (
        <li key={event.id} className="relative pl-8">
          <span
            aria-hidden
            className="absolute left-2 top-2 h-full w-px bg-border last:hidden"
          />
          <span
            aria-hidden
            className={cn(
              "absolute left-0 top-1.5 size-4 rounded-full border-4 border-surface",
              toneClasses[event.tone ?? "default"],
            )}
          />
          <div className="rounded-[var(--radius-card)] border border-border bg-surface px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-foreground">{event.title}</h3>
              {event.timestamp ? (
                <span className="font-mono text-xs text-muted">{event.timestamp}</span>
              ) : null}
            </div>
            {event.description ? (
              <p className="mt-1 text-sm leading-6 text-muted">{event.description}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
