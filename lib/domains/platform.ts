import "server-only";

/**
 * Registering a verified domain with the hosting platform (§2) — step two.
 *
 * **Verification and registration are different things, and only doing the first
 * is why a verified domain still 404s.** Verification proves the merchant owns
 * the hostname, which is what makes Markii willing to route it. Registration
 * tells *Vercel* the hostname belongs to this project, which is what makes the
 * request arrive at all: Vercel matches the `Host` header against domains
 * registered to a project and rejects the rest at its edge, before `proxy.ts`
 * ever runs. It is also what causes a TLS certificate to be issued.
 *
 * **Ordering is a security property, not a convenience.** Registration happens
 * only after the TXT record proves ownership. Registering on *claim* would let
 * anyone add any hostname to Markii's Vercel project — squatting the project's
 * domain namespace against a plan limit, on nothing more than a form submission.
 *
 * Unconfigured, everything here **refuses and says so** rather than pretending
 * (the `configuration_required` pattern in `lib/payments/` and `lib/email/`).
 * It never blocks verification: ownership is still a real, useful fact, and
 * failing it because Markii lacks a credential would blame the merchant for
 * something that is Markii's to fix.
 *
 * Not imported by `./index` — that module is in the proxy bundle and has no
 * business carrying an API client.
 */

import { isReservedHost } from "./records";

const API = "https://api.vercel.com";

/** Short: this sits on a merchant-facing request, behind their own DNS wait. */
const TIMEOUT_MS = 5_000;

type Credentials = { token: string; projectId: string; teamId: string | null };

function credentials(): Credentials | null {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectId) return null;
  return { token, projectId, teamId: process.env.VERCEL_TEAM_ID || null };
}

export function isPlatformConfigured(): boolean {
  return credentials() !== null;
}

export const PLATFORM_UNCONFIGURED =
  "Markii cannot attach this domain to its hosting platform — VERCEL_TOKEN and VERCEL_PROJECT_ID " +
  "are not set on this deployment. Until they are, a verified domain will not serve traffic. " +
  "This is Markii's to fix, not yours.";

function url(creds: Credentials, path: string): string {
  const q = creds.teamId ? `?teamId=${encodeURIComponent(creds.teamId)}` : "";
  return `${API}${path}${q}`;
}

/** Only the fields this module reads. Vercel returns a great deal more. */
type VercelBody = {
  error?: { code?: string; message?: string };
  misconfigured?: boolean;
} | null;

type CallResult =
  | { ok: true; status: number; body: VercelBody }
  | { ok: false; status: number | null; body: VercelBody; problem: string };

async function call(
  creds: Credentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<CallResult> {
  try {
    const res = await fetch(url(creds, path), {
      method,
      headers: {
        authorization: `Bearer ${creds.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    let parsed: VercelBody = null;
    try {
      parsed = (await res.json()) as VercelBody;
    } catch {
      // A body that is not JSON is not a reason to lose the status.
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        body: parsed,
        problem: parsed?.error?.message ?? `Vercel answered ${res.status}.`,
      };
    }
    return { ok: true, status: res.status, body: parsed };
  } catch (e) {
    // Reported, never thrown: the platform being unreachable must not fail an
    // action whose real work — proving ownership — already succeeded.
    return {
      ok: false,
      status: null,
      body: null,
      problem: e instanceof Error ? e.message : String(e),
    };
  }
}

export type RegisterResult =
  | { ok: true; alreadyRegistered: boolean }
  | { ok: false; code: "configuration_required" | "taken" | "provider_error"; message: string };

/**
 * Attach a verified hostname to the Vercel project.
 *
 * **Idempotent**, because it runs on every `domains.verify` — that makes the
 * merchant's "Check DNS" button the repair path for a registration that failed
 * the first time, rather than needing a separate button nobody would find.
 */
export async function registerDomain(host: string): Promise<RegisterResult> {
  const creds = credentials();
  if (!creds) {
    return { ok: false, code: "configuration_required", message: PLATFORM_UNCONFIGURED };
  }

  const added = await call(creds, "POST", `/v10/projects/${creds.projectId}/domains`, {
    name: host,
  });
  if (added.ok) return { ok: true, alreadyRegistered: false };

  /**
   * A 409 is ambiguous and the two meanings could not be more different: the
   * domain is already on *this* project (success, nothing to do) or it is held
   * by *another* Vercel project (a real conflict Markii cannot resolve). Ask
   * rather than guess — reporting the second as success is how a domain ends up
   * marked working while serving nothing.
   */
  if (added.status === 409) {
    const existing = await call(
      creds,
      "GET",
      `/v9/projects/${creds.projectId}/domains/${encodeURIComponent(host)}`,
    );
    if (existing.ok) return { ok: true, alreadyRegistered: true };
    return {
      ok: false,
      code: "taken",
      message:
        `${host} is already attached to a different Vercel project. Remove it there, then check ` +
        `again.`,
    };
  }

  return { ok: false, code: "provider_error", message: added.problem };
}

/**
 * Detach on disconnect, so the hostname can be attached elsewhere afterwards.
 *
 * **Refuses a platform host outright.** Every caller passes a site's own
 * `custom_domain`, and `connectDomain` already refuses to let a merchant claim
 * `ROOT_DOMAIN` or a `*.vercel.app` host — so this is unreachable today. It is
 * here because the operation is an irreversible DELETE against the live project
 * that serves every merchant: if a future change ever passed the wrong value,
 * the failure would be Markii's own apex being detached, and there is no undo.
 * Defence in depth is cheap; a deleted production domain is not.
 */
export async function unregisterDomain(
  host: string,
): Promise<{ ok: boolean; message: string | null }> {
  if (isReservedHost(host)) {
    console.error(`refused to detach the platform host ${host}`);
    return { ok: false, message: `${host} is a Markii hostname and is never detached.` };
  }

  const creds = credentials();
  if (!creds) return { ok: false, message: PLATFORM_UNCONFIGURED };

  const res = await call(
    creds,
    "DELETE",
    `/v9/projects/${creds.projectId}/domains/${encodeURIComponent(host)}`,
  );
  // Already gone is the outcome we wanted.
  if (res.ok || res.status === 404) return { ok: true, message: null };
  return { ok: false, message: res.problem };
}

export type PlatformStatus = {
  /** False means Markii has no credentials — the merchant can do nothing about it. */
  configured: boolean;
  /** Null when unknown (unconfigured, or the platform was unreachable). */
  registered: boolean | null;
  /**
   * Vercel's own view of whether DNS reaches it. Null when unknown. Distinct
   * from Markii's `pointsToMarkii`, which is read from DNS directly — they
   * answer the same question from two sides and can legitimately disagree while
   * records propagate.
   */
  misconfigured: boolean | null;
  problem: string | null;
};

/**
 * What the platform currently thinks, read live.
 *
 * Not stored, for the same reason `pointsToMarkii` is not stored: it is a fact
 * about the present, and a cached copy is a claim nobody re-tested.
 */
export async function platformStatus(host: string): Promise<PlatformStatus> {
  const creds = credentials();
  if (!creds) {
    return {
      configured: false,
      registered: null,
      misconfigured: null,
      problem: PLATFORM_UNCONFIGURED,
    };
  }

  const domain = await call(
    creds,
    "GET",
    `/v9/projects/${creds.projectId}/domains/${encodeURIComponent(host)}`,
  );

  if (!domain.ok && domain.status === 404) {
    return {
      configured: true,
      registered: false,
      misconfigured: null,
      problem:
        "This domain is not attached to Markii's hosting project yet, so requests to it will not " +
        "reach your storefront. Check again to retry.",
    };
  }

  if (!domain.ok) {
    return { configured: true, registered: null, misconfigured: null, problem: domain.problem };
  }

  const config = await call(creds, "GET", `/v6/domains/${encodeURIComponent(host)}/config`);
  return {
    configured: true,
    registered: true,
    misconfigured: config.ok ? Boolean(config.body?.misconfigured) : null,
    problem: config.ok ? null : config.problem,
  };
}
