"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  deleteStaff,
  inviteStaff,
  updateStaff,
  type StaffMember,
  type StaffRole,
} from "@/lib/api/org";
import { ApiClientError } from "@/lib/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label, Select } from "@/components/ui/field";

/**
 * `owner` is deliberately absent. There is exactly one owner, recorded on
 * `organizations.ownerId`, and it changes only by an explicit transfer —
 * handing it out here would make "who owns billing" ambiguous. The API refuses
 * it too; leaving it out of the picker means nobody discovers that by being
 * rejected.
 */
const ASSIGNABLE_ROLES: StaffRole[] = [
  "administrator",
  "catalog_manager",
  "commerce_manager",
  "analyst",
  "developer",
  "viewer",
];

const ROLE_LABEL: Record<StaffRole, string> = {
  owner: "Owner",
  administrator: "Administrator",
  catalog_manager: "Catalog manager",
  commerce_manager: "Commerce manager",
  analyst: "Analyst",
  developer: "Developer",
  viewer: "Viewer",
};

export function StaffPanel({
  staff,
  seatLimit,
  currentUserId,
}: {
  staff: StaffMember[];
  seatLimit: number | null;
  currentUserId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<StaffMember | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRole>("viewer");

  const seatsFull = seatLimit !== null && staff.length >= seatLimit;

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">Staff</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Roles are enforced on every call the same way for people, agents, and API tokens.
          </p>
        </div>
        <span className="text-sm text-muted">
          {staff.length}
          {seatLimit !== null ? ` / ${seatLimit}` : ""} seat{staff.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="text-muted">
            <tr className="border-b border-border">
              <th className="py-2 pr-4 font-medium">Member</th>
              <th className="py-2 pr-4 font-medium">Role</th>
              <th className="py-2 pr-4 font-medium">Stores</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {staff.map((m) => {
              const isOwner = m.role === "owner";
              const isSelf = currentUserId !== null && m.userId === currentUserId;
              return (
                <tr key={m.id} className="border-b border-border last:border-0">
                  <td className="py-3 pr-4">
                    <div className="font-medium text-foreground">{m.name || m.email}</div>
                    {m.name ? <div className="text-xs text-muted">{m.email}</div> : null}
                  </td>
                  <td className="py-3 pr-4">
                    {/*
                      The owner is not editable here and neither is your own row —
                      the API refuses both, so offering a control that cannot
                      work would just be a rejection waiting to happen.
                    */}
                    {isOwner || isSelf ? (
                      <span className="text-foreground">{ROLE_LABEL[m.role]}</span>
                    ) : (
                      <Select
                        aria-label={`Role for ${m.email}`}
                        className="w-44"
                        value={m.role}
                        disabled={busy !== null}
                        onChange={(e) =>
                          void run(`role-${m.id}`, () =>
                            updateStaff(m.id, { role: e.target.value as StaffRole }),
                          )
                        }
                      >
                        {ASSIGNABLE_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-muted">
                    {m.storeIds === "all"
                      ? "All stores"
                      : `${m.storeIds.length} store${m.storeIds.length === 1 ? "" : "s"}`}
                  </td>
                  <td className="py-3 pr-4">
                    <Badge
                      variant={
                        m.status === "active"
                          ? "success"
                          : m.status === "invited"
                            ? "neutral"
                            : "warning"
                      }
                    >
                      {m.status}
                    </Badge>
                  </td>
                  <td className="py-3 text-right">
                    {isOwner || isSelf ? (
                      <span className="text-xs text-muted">{isOwner ? "Owner" : "You"}</span>
                    ) : (
                      <Button
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => setRemoving(m)}
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <form
        className="mt-5 flex flex-wrap items-end gap-2 border-t border-border pt-5"
        onSubmit={(e) => {
          e.preventDefault();
          const value = email.trim();
          if (!value) return;
          void run("invite", async () => {
            await inviteStaff({ email: value, role, storeIds: "all" });
            setEmail("");
          });
        }}
      >
        <div>
          <Label htmlFor="invite-email">Invite by email</Label>
          <Input
            id="invite-email"
            type="email"
            value={email}
            placeholder="colleague@example.com"
            disabled={busy !== null || seatsFull}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1.5 w-64"
          />
        </div>
        <div>
          <Label htmlFor="invite-role">Role</Label>
          <Select
            id="invite-role"
            className="mt-1.5 w-48"
            value={role}
            disabled={busy !== null || seatsFull}
            onChange={(e) => setRole(e.target.value as StaffRole)}
          >
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" disabled={busy !== null || seatsFull || !email.trim()}>
          {busy === "invite" ? "Inviting…" : "Send invite"}
        </Button>
      </form>

      {/*
        Said before the attempt, not after the refusal: the API enforces the seat
        limit, and finding out by being rejected is a worse way to learn it.
      */}
      {seatsFull ? (
        <p className="mt-3 text-sm text-warning-text">
          Your plan allows {seatLimit} staff seat{seatLimit === 1 ? "" : "s"}. Remove someone or
          change plan to invite another.
        </p>
      ) : null}

      {error ? <FieldError>{error}</FieldError> : null}

      <ConfirmDialog
        open={removing !== null}
        danger
        busy={busy?.startsWith("remove-") ?? false}
        title={`Remove ${removing?.email ?? ""}?`}
        description="They lose access to this organization immediately. Anything they already did stays on the record — removing someone does not rewrite history."
        confirmLabel="Remove member"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing;
          setRemoving(null);
          if (target) void run(`remove-${target.id}`, () => deleteStaff(target.id));
        }}
      />
    </section>
  );
}
