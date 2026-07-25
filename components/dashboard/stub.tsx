import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export function DashboardStub({
  title,
  description,
  actionHref,
  actionLabel,
}: {
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div>
      <PageHeader
        title={title}
        description={description}
        actions={
          actionHref && actionLabel ? (
            <ButtonLink href={actionHref}>{actionLabel}</ButtonLink>
          ) : undefined
        }
      />
      <EmptyState
        title="Waiting on API"
        description="This screen calls the live backend. It will populate when the endpoint is available."
      />
    </div>
  );
}
