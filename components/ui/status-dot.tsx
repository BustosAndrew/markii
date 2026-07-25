import { cn } from "@/lib/utils";

const tones = {
  live: "bg-success-text",
  draft: "bg-muted-soft",
  paused: "bg-warning-text",
  error: "bg-error-text",
} as const;

export function StatusDot({
  tone = "draft",
  className,
  label,
}: {
  tone?: keyof typeof tones;
  className?: string;
  label?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className={cn("size-2 rounded-full", tones[tone])} aria-hidden />
      {label ? <span className="text-sm text-muted">{label}</span> : null}
    </span>
  );
}
