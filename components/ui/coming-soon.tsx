import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

export function ComingSoon({
  title = "Not available yet",
  description = "This part of Markii isn’t ready for use yet.",
  className,
  action,
}: {
  title?: string;
  description?: string;
  /** @deprecated Unused — do not show internal API section labels to merchants. */
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
    />
  );
}
