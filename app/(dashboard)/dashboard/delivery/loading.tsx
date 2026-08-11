import { PageHeader } from "@/components/ui/page-header";

export default function DeliveryLoading() {
  return (
    <div>
      <PageHeader
        title="Delivery"
        description="Upload the files you sell and review digital delivery usage."
      />
      <div className="space-y-6">
        <div className="h-48 animate-pulse rounded-[var(--radius-card)] border border-border bg-surface" />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="h-28 animate-pulse rounded-[var(--radius-card)] border border-border bg-surface" />
          <div className="h-28 animate-pulse rounded-[var(--radius-card)] border border-border bg-surface" />
        </div>
        <div className="h-72 animate-pulse rounded-[var(--radius-card)] border border-border bg-surface" />
      </div>
    </div>
  );
}
