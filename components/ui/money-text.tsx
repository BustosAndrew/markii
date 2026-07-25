import { formatCents } from "@/lib/api/money";
import { cn } from "@/lib/utils";

export function MoneyText({
  cents,
  currency = "USD",
  className,
}: {
  cents: number;
  currency?: string;
  className?: string;
}) {
  return (
    <span className={cn("tabular-nums", className)}>
      {formatCents(cents, currency)}
    </span>
  );
}
