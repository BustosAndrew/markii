import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

export function ComingSoon({
  title = "Coming soon",
  description = "This surface is planned and will populate when the API section is live.",
  apiSection,
  className,
  action,
}: {
  title?: string;
  description?: string;
  apiSection?: string;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <EmptyState
      title={title}
      description={description}
      action={action}
      className={cn(className)}
    >
      {apiSection ? (
        <span className="inline-flex rounded-full bg-surface-elevated px-2.5 py-1 text-xs font-medium text-muted">
          {apiSection}
        </span>
      ) : null}
    </EmptyState>
  );
}
