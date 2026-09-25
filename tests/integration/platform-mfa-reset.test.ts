import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, enrollMfa, signUpMerchant, sql } from "./helpers";

/**
 * The operator's MFA reset (G12, `platform.resetMfa`) against real Supabase:
 * the factor is really deleted at GoTrue, the old session really stops
 * working, the next sign-in really meets the enrolment gate, and the reset
 * lands in the merchant's own audit log with the operator's evidence.
 *
 * **The notice is a real Resend send, so it must not reach a real mailbox.**
 * Fixtures sign up at `@markii.shop`, where a send to a nonexistent mailbox
 * bounces against Markii's own reputation. The target's *account* email —
 * which is what the action mails — is moved to Resend's sandbox
 * (`delivered+…@resend.dev`) before anything is reset.
 */
const OPERATOR_DOMAIN = (process.env.PLATFORM_OPERATOR_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .find((s) => s.startsWith("@"))
  ?.slice(1);

async function setAccountEmail(userId: string, email: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const res = await fetch(`${url}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ email, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`email change failed: ${res.status} ${await res.text()}`);
}

describe.skipIf(!OPERATOR_DOMAIN)("platform MFA reset", () => {
  const operator = new Client();
  const merchant = new Client();
  const bystander = new Client();
  const cleanup = new Cleanup();
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const sandboxEmail = `delivered+mfa-${stamp}@resend.dev`;
  let password: string;
  let orgId: string;
  let merchantId: string;
  let operatorId: string;
  let operatorOrgId: string;

  beforeAll(async () => {
    const op = await signUpMerchant(operator, "mfareset-op", { domain: OPERATOR_DOMAIN });
    cleanup.merchantEmails.push(op.email);
    const opMe = (await operator.get("/api/me")).json;
    operatorId = opMe.user.id;
    operatorOrgId = opMe.org.id;

    const m = await signUpMerchant(merchant, "mfareset");
    password = m.password;
    const me = (await merchant.get("/api/me")).json;
    orgId = me.org.id;
    merchantId = me.user.id;
    await setAccountEmail(merchantId, sandboxEmail);
    cleanup.merchantEmails.push(sandboxEmail);

    const b = await signUpMerchant(bystander, "mfareset-by");
    cleanup.merchantEmails.push(b.email);
  }, 240_000);

  afterAll(async () => {
    await cleanup.run();
  });

  const resetPath = (org: string, user: string, dry = false) =>
    `/api/admin/orgs/${org}/staff/${user}/reset-mfa${dry ? "?dryRun=1" : ""}`;

  it("shows the operator each member's MFA state", async () => {
    const view = await operator.get(`/api/admin/orgs/${orgId}`);
    expect(view.status).toBe(200);
    const member = view.json.staff.find((s: { userId: string }) => s.userId === merchantId);
    expect(member).toMatchObject({ role: "owner", status: "active", mfaEnrolled: true });
  });

  it("refuses a merchant with 403 and a live session", async () => {
    expect((await bystander.get("/api/me")).status).toBe(200);
    const res = await bystander.post(resetPath(orgId, merchantId), {
      verification: "I am definitely the owner",
    });
    expect(res.status).toBe(403);
  });

  it("requires a real verification note", async () => {
    const res = await operator.post(resetPath(orgId, merchantId), { verification: "ok" });
    expect(res.status).toBe(400);
  });

  it("answers 404 for someone who is not a member of that org", async () => {
    const res = await operator.post(resetPath(orgId, operatorId), {
      verification: "Not a member of this org at all",
    });
    expect(res.status).toBe(404);
  });

  /** Whoever holds an operator's password but not their phone must not be able to clear it. */
  it("refuses an operator resetting their own factor", async () => {
    const res = await operator.post(resetPath(operatorOrgId, operatorId), {
      verification: "Resetting my own authenticator",
    });
    expect(res.status).toBe(403);
  });

  it("dry-runs without removing anything", async () => {
    const res = await operator.post(resetPath(orgId, merchantId, true), {
      verification: "Dry run to see what would happen",
    });
    expect(res.status).toBe(200);
    expect(res.json.result.factorsToRemove).toBeGreaterThanOrEqual(1);
    const [{ n }] = await sql`select count(*)::int n from auth.mfa_factors where user_id = ${merchantId}::uuid`;
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("removes the factor, voids the codes and ends every session", async () => {
    const [{ n: codesBefore }] =
      await sql`select count(*)::int n from mfa_recovery_codes where user_id = ${merchantId} and used_at is null`;
    expect(codesBefore).toBeGreaterThan(0);

    const res = await operator.post(resetPath(orgId, merchantId), {
      verification: "Integration test: replied from the account email and matched the last order",
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.result.factorsRemoved).toBeGreaterThanOrEqual(1);
    expect(res.json.result.sessionsEnded).toBeGreaterThanOrEqual(1);

    const [{ n: factors }] =
      await sql`select count(*)::int n from auth.mfa_factors where user_id = ${merchantId}::uuid`;
    expect(factors).toBe(0);
    const [{ n: codes }] =
      await sql`select count(*)::int n from mfa_recovery_codes where user_id = ${merchantId} and used_at is null`;
    expect(codes).toBe(0);
    const [{ n: sessions }] =
      await sql`select count(*)::int n from auth.sessions where user_id = ${merchantId}::uuid`;
    expect(sessions).toBe(0);
  });

  it("stops the old session and sends the next sign-in to enrolment", async () => {
    // The old browser: its session row is gone and it has no factor.
    expect([401, 403]).toContain((await merchant.get("/api/me")).status);

    const fresh = new Client();
    const inn = await fresh.post("/api/auth/sign-in", { email: sandboxEmail, password });
    expect(inn.status).toBeLessThan(400);
    const mfa = await fresh.get("/api/auth/mfa");
    expect(mfa.json.required).toBe(true);
    expect(mfa.json.gate.status).toBe("enroll");

    // And they can enrol again — the reset is a way back in, not a lockout.
    const again = await enrollMfa(fresh);
    expect(again.recoveryCodes.length).toBeGreaterThan(0);
    expect((await fresh.get("/api/me")).status).toBe(200);

    const recorded = (await fresh.get("/api/org/audit?actionId=platform.resetMfa")).json.items;
    const done = recorded.find((e: { ok: boolean }) => e.ok);
    expect(done.actor).toMatchObject({ type: "operator", name: "Markii operator" });
    expect(done.undoable).toBe(false);
    expect(JSON.stringify(done)).toContain("matched the last order");
  }, 60_000);
});
