"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { revokeSession, type SessionRecord } from "@/lib/api/org";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LocalDateTime } from "@/components/ui/local-date";

/**
 * The signed-in user's own devices. Revoking the current session is allowed
 * and is how "sign out everywhere" is built — check `wasCurrent` and leave
 * rather than refetching against a cookie that no longer refreshes.
 *
 * Do not say a device is cut off instantly: the refresh chain dies immediately,
 * but an access token already issued lives out its hour.
 */
export function SessionsPanel({ sessions }: { sessions: SessionRecord[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<SessionRecord | "everywhere" | null>(null);

  async function leaveIfCurrent(wasCurrent: boolean) {
    if (wasCurrent) {
      window.location.assign("/sign-in");
      return;
    }
    router.refresh();
  }

  async function revokeOne(id: string) {
    const result = await revokeSession(id);
    await leaveIfCurrent(result.wasCurrent);
  }

  async function revokeEverywhere() {
    const others = sessions.filter((s) => !s.current);
    for (const session of others) {
      await revokeSession(session.id);
    }
    const current = sessions.find((s) => s.current);
    if (current) {
      const result = await revokeSession(current.id);
      await leaveIfCurrent(result.wasCurrent);
      return;
    }
    router.refresh();
  }

  async function confirm() {
    if (target === null) return;
    setBusy(target === "everywhere" ? "everywhere" : target.id);
    setError(null);
    try {
      if (target === "everywhere") {
        await revokeEverywhere();
      } else {
        await revokeOne(target.id);
      }
      setTarget(null);
    } catch (err) {
      setError(publicErrorMessage(err, "That did not work."));
    } finally {
      setBusy(null);
    }
  }

  const confirmingCurrent = target !== null && target !== "everywhere" && target.current;

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">Signed-in devices</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            These are your browsers, not the org&apos;s. Signing a device out ends
            its refresh immediately; a tab that is already open may stay signed in
            for up to an hour.
          </p>
        </div>
        {sessions.length > 1 ? (
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => setTarget("everywhere")}
          >
            Sign out everywhere
          </Button>
        ) : null}
      </div>

      {error ? <p className="mt-3 text-sm text-error-text">{error}</p> : null}

      {sessions.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No sessions.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex flex-wrap items-start justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-foreground">
                    {deviceLabel(session.userAgent)}
                  </p>
                  {session.current ? <Badge variant="info">This device</Badge> : null}
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {session.ip ?? "IP not recorded"}
                  {" · Last active "}
                  <LocalDateTime value={session.lastActiveAt} />
                  {" · Signed in "}
                  <LocalDateTime value={session.createdAt} />
                </p>
              </div>
              <Button
                variant="secondary"
                disabled={busy !== null}
                onClick={() => setTarget(session)}
              >
                {session.current ? "Sign out" : "Sign out device"}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={target !== null}
        danger
        busy={busy !== null}
        title={
          target === "everywhere"
            ? "Sign out everywhere?"
            : confirmingCurrent
              ? "Sign out of this browser?"
              : "Sign this device out?"
        }
        description={
          target === "everywhere"
            ? "Every signed-in browser, including this one, will be signed out. An already-open tab may stay signed in for up to an hour."
            : confirmingCurrent
              ? "You will need to sign in again on this browser. An already-open tab may stay signed in for up to an hour."
              : "That device will be signed out. An already-open tab may stay signed in for up to an hour."
        }
        confirmLabel={target === "everywhere" ? "Sign out everywhere" : "Sign out"}
        onConfirm={() => void confirm()}
        onClose={() => {
          if (busy === null) setTarget(null);
        }}
      />
    </section>
  );
}

function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";

  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Chrome\//.test(userAgent)
      ? "Chrome"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : null;
  const os = /Macintosh|Mac OS X/.test(userAgent)
    ? "macOS"
    : /Windows/.test(userAgent)
      ? "Windows"
      : /Android/.test(userAgent)
        ? "Android"
        : /iPhone|iPad/.test(userAgent)
          ? "iOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;

  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  return "Unknown device";
}
