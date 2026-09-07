import { redirect } from "next/navigation";
import { AuditLog } from "@/components/dashboard/audit-log";
import { FetchError } from "@/components/dashboard/fetch-error";
import { SettingsShell } from "@/components/dashboard/settings-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { ListFilters } from "@/components/ui/list-filters";
import { Pagination } from "@/components/ui/pagination";
import { firstParam, loadOrError, parseLimit, parsePage } from "@/lib/api/load";
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_RISK_TIERS,
  canReadOrgAudit,
  type AuditActorType,
  type AuditRiskTier,
  type OrgAuditFilters,
} from "@/lib/api/org";
import { getMe, listOrgAudit } from "@/lib/api/server";

function asActorType(value: string | undefined): AuditActorType | undefined {
  return value && (AUDIT_ACTOR_TYPES as readonly string[]).includes(value)
    ? (value as AuditActorType)
    : undefined;
}

function asRiskTier(value: string | undefined): AuditRiskTier | undefined {
  return value && (AUDIT_RISK_TIERS as readonly string[]).includes(value)
    ? (value as AuditRiskTier)
    : undefined;
}

export default async function SettingsAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await loadOrError(() => getMe());
  if (me.data && !canReadOrgAudit(me.data.role)) {
    redirect("/dashboard/settings/team");
  }

  const sp = await searchParams;
  const okRaw = firstParam(sp.ok);
  const filters: OrgAuditFilters = {
    actorType: asActorType(firstParam(sp.actorType)),
    actorId: firstParam(sp.actorId) || undefined,
    actionId: firstParam(sp.actionId) || undefined,
    riskTier: asRiskTier(firstParam(sp.riskTier)),
    ok: okRaw === "true" ? true : okRaw === "false" ? false : undefined,
    from: firstParam(sp.from) || undefined,
    to: firstParam(sp.to) || undefined,
    page: parsePage(sp.page),
    limit: parseLimit(sp.limit),
  };

  const audit = await loadOrError(() => listOrgAudit(filters));

  return (
    <SettingsShell
      title="Audit"
      description="Who did what in this organization. Refused attempts are listed too — that is the incident view, not a failure of the log."
    >
      <ListFilters
        search={false}
        dateRange
        textFilters={[
          {
            key: "actionId",
            label: "Action",
            placeholder: "Action id — catalog.updateProduct",
          },
        ]}
        filters={[
          {
            key: "actorType",
            label: "Actor",
            options: [
              { value: "user", label: "Person" },
              { value: "agent", label: "Agent" },
              { value: "token", label: "Token" },
              { value: "system", label: "System" },
            ],
          },
          {
            key: "riskTier",
            label: "Risk",
            options: [
              { value: "read", label: "Read" },
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ],
          },
          {
            key: "ok",
            label: "Outcome",
            options: [
              { value: "true", label: "Applied" },
              { value: "false", label: "Refused" },
            ],
          },
        ]}
      />

      {!audit.data ? (
        <FetchError
          title="Audit log unavailable"
          message={audit.error ?? "Could not load the audit log."}
        />
      ) : audit.data.items.length === 0 ? (
        <EmptyState
          title={
            filters.ok === false
              ? "No refused attempts"
              : filters.actionId || filters.actorType || filters.from
                ? "No matching entries"
                : "Nothing recorded yet"
          }
          description={
            filters.ok === false
              ? "Refused attempts appear here when someone tries a change they cannot make."
              : "Every action in this organization is listed here once it runs — including ones that were refused."
          }
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted">
            Showing {audit.data.items.length} of {audit.data.total}
          </p>
          <AuditLog items={audit.data.items} />
          <Pagination
            page={audit.data.page}
            limit={audit.data.limit}
            total={audit.data.total}
          />
        </>
      )}
    </SettingsShell>
  );
}
