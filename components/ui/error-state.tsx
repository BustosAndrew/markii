"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  className,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-start rounded-[var(--radius-card)] border border-border bg-surface px-6 py-10",
        className,
      )}
    >
      <h2 className="text-base font-medium text-foreground">{title}</h2>
      {message ? (
        <p className="mt-2 max-w-md text-sm leading-6 text-muted">{message}</p>
      ) : null}
      {onRetry ? (
        <Button variant="secondary" className="mt-6" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
