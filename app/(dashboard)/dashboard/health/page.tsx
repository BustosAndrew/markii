import type { ReadinessReport } from "@/lib/api/readiness";
import { isPlannedError } from "@/lib/api/planned";
import { loadOrError } from "@/lib/api/load";
// In-process, so the session cookie is inherited rather than dropped — see lib/api/server.ts.
import { getReadinessOverview, listReadinessIssues } from "@/lib/api/server";
import {
  HealthPagePreview,
  type IssuesPage,
} from "@/components/dashboard/health-page-preview";
import { PageHeader } from "@/components/ui/page-header";

export default async function HealthPage() {
  let planned = false;
  let error: string | null = null;
  let report: ReadinessReport | null = null;
  let initialIssues: IssuesPage | null = null;

  try {
    report = await getReadinessOverview();
  } catch (caught) {
    if (isPlannedError(caught)) {
      planned = true;
    } else if (caught instanceof Error) {
      error = caught.message;
    } else {
      error = "Health data could not be loaded.";
    }
  }

  if (report && !planned && !error) {
    const issues = await loadOrError(() =>
      listReadinessIssues({ status: "open", sort: "-severity", limit: 50 }),
    );
    if (issues.data) {
      initialIssues = issues.data;
    }
  }

  return (
    <div>
      <PageHeader
        title="Health"
        description="Readiness scoring and issue workflows for catalog quality, checkout, and protocol coverage."
      />
      <HealthPagePreview
        report={report}
        initialIssues={initialIssues}
        planned={planned}
        error={error}
      />
    </div>
  );
}
