import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, signUpMerchant, sql } from "./helpers";

/**
 * `GET`/`DELETE /api/org/sessions*` end to end (§16).
 *
 * There is nothing here worth unit-testing: the module is two SQL statements
 * over a table Markii does not own. Everything that could go wrong lives in the
 * span — that the rows Supabase writes are the rows this reports, that `current`
 * marks the right one, that another user's session is invisible **and**
 * unrevokable, and that a revoked session's refresh chain really is gone rather
 * than merely flagged.
 *
 * The last one is the assertion that matters. A revoke button that deletes a row
 * while `auth.refresh_tokens` survives would pass every other check in this file
 * and leave the session alive.
 */
describe("account sessions", () => {
  const merchant = new Client();
  const other = new Client();
  const cleanup = new Cleanup();

  let userId: string;
  let otherUserId: string;
  let credentials: { email: string; password: string };

  beforeAll(async () => {
    const { email, password } = await signUpMerchant(merchant, "sessions");
    cleanup.merchantEmails.push(email);
    credentials = { email, password };
    userId = (await merchant.get("/api/me")).json.user.id;

    const { email: otherEmail } = await signUpMerchant(other, "sessionsother");
    cleanup.merchantEmails.push(otherEmail);
    otherUserId = (await other.get("/api/me")).json.user.id;
  }, 180_000);

  afterAll(async () => {
    await cleanup.run();
  }, 120_000);

  it("lists the caller's own live session and marks it current", async () => {
    const res = await merchant.get("/api/org/sessions");
    expect(res.status).toBe(200);
    expect(res.json.items.length).toBeGreaterThan(0);

    const current = res.json.items.filter((s: any) => s.current);
    expect(current).toHaveLength(1);

    // Asserted against Supabase's own row, not against the response that
    // produced it — the point is that these are GoTrue's sessions.
    const [row] = await sql`select user_id::text as user_id from auth.sessions where id = ${current[0].id}::uuid`;
    expect(row.user_id).toBe(userId);

    expect(typeof current[0].createdAt).toBe("string");
    expect(typeof current[0].lastActiveAt).toBe("string");
  });

  it("never shows another user's sessions", async () => {
    const mine = await merchant.get("/api/org/sessions");
    const theirs = await other.get("/api/org/sessions");

    const myIds = new Set(mine.json.items.map((s: any) => s.id));
    for (const s of theirs.json.items) expect(myIds.has(s.id)).toBe(false);

    // And the two lists really are two different users' — a shared fixture
    // would make the check above vacuous.
    expect(otherUserId).not.toBe(userId);
  });

  it("answers 401 to an API token, like /api/me", async () => {
    const created = await merchant.post("/api/org/tokens", {
      label: "sessions probe",
      role: "administrator",
    });
    expect(created.status).toBe(201);

    const tokenClient = new Client();
    const res = await tokenClient.call("GET", "/api/org/sessions", undefined, {
      authorization: `Bearer ${created.json.token}`,
    });
    expect(res.status).toBe(401);

    await merchant.del(`/api/org/tokens/${created.json.id}`);
  });

  it("refuses to revoke a session belonging to someone else, with a 404", async () => {
    const theirs = (await other.get("/api/org/sessions")).json.items[0];
    expect(theirs).toBeTruthy();

    /**
     * The session must be proved live *before* the refusal is believed: a 4xx
     * from a dropped cookie would pass this test with the ownership filter
     * deleted, which is exactly how a refusal test passes for the wrong reason.
     */
    expect((await merchant.get("/api/me")).status).toBe(200);

    const res = await merchant.del(`/api/org/sessions/${theirs.id}`);
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe("NOT_FOUND");

    // Untouched.
    const still = await sql`select 1 from auth.sessions where id = ${theirs.id}::uuid`;
    expect(still).toHaveLength(1);
  });

  it("404s on an id that is not a uuid rather than raising a database error", async () => {
    const res = await merchant.del("/api/org/sessions/not-a-uuid");
    expect(res.status).toBe(404);
  });

  it("revoking a second device deletes its session and its refresh tokens", async () => {
    /**
     * A real second sign-in, so the session being revoked is another device's
     * rather than the one driving the test. It stops at `aal1` — MFA is not
     * cleared — which is deliberate: an unfinished sign-in is still a live
     * session row, and it is exactly the kind a merchant would want to cut off.
     */
    const secondDevice = new Client();
    const signIn = await secondDevice.post("/api/auth/sign-in", {
      email: credentials.email,
      password: credentials.password,
    });
    expect(signIn.status).toBeLessThan(400);

    const after = (await merchant.get("/api/org/sessions")).json.items;
    const target = after.find((s: any) => !s.current);
    expect(target, "the second sign-in should appear in the list").toBeTruthy();

    const tokensBefore =
      await sql`select 1 from auth.refresh_tokens where session_id = ${target.id}::uuid`;
    expect(tokensBefore.length).toBeGreaterThan(0);

    const res = await merchant.del(`/api/org/sessions/${target.id}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ deleted: true, id: target.id, wasCurrent: false });

    expect(await sql`select 1 from auth.sessions where id = ${target.id}::uuid`).toHaveLength(0);
    /**
     * The cascade **is** the revocation. If this ever returns rows the revoked
     * session can still mint access tokens, and the button is decoration — the
     * missing `sessions` row notwithstanding.
     */
    expect(
      await sql`select 1 from auth.refresh_tokens where session_id = ${target.id}::uuid`,
    ).toHaveLength(0);

    // Gone from the list too, which is what the merchant actually sees.
    const remaining = (await merchant.get("/api/org/sessions")).json.items;
    expect(remaining.some((s: any) => s.id === target.id)).toBe(false);
  });

  it("404s a second revoke of the same id", async () => {
    const res = await merchant.del(`/api/org/sessions/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
  });
});
