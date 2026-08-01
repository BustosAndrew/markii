import { describe, expect, it } from "vitest";
import { checkRedeemable, expiryFor, newGrantToken } from "./delivery";

/**
 * Digital delivery rules (§18.8) — pure, no database.
 *
 * The redemption gate is the whole of a download limit's enforcement, so each
 * refusal is tested for **which** reason it gives: a shopper who hit their cap,
 * one whose link expired, and one whose order was refunded need three different
 * messages, and only the last is not something the merchant might fix for them.
 */

const grant = (over: Partial<Parameters<typeof checkRedeemable>[0]> = {}) => ({
  revokedAt: null,
  revokedReason: null,
  expiresAt: null,
  downloadLimit: null,
  downloadCount: 0,
  ...over,
});

describe("checkRedeemable", () => {
  it("allows an unlimited, unexpiring, unrevoked grant", () => {
    expect(checkRedeemable(grant())).toBeNull();
  });

  it("allows a grant below its limit", () => {
    expect(checkRedeemable(grant({ downloadLimit: 5, downloadCount: 4 }))).toBeNull();
  });

  it("refuses at the limit, not one past it", () => {
    // The fifth download of a five-download grant must be the last one allowed.
    expect(checkRedeemable(grant({ downloadLimit: 5, downloadCount: 5 }))?.code).toBe(
      "limit_reached",
    );
  });

  it("refuses an expired grant", () => {
    const past = new Date(Date.now() - 1000);
    expect(checkRedeemable(grant({ expiresAt: past }))?.code).toBe("expired");
  });

  it("treats the expiry instant itself as expired", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    expect(checkRedeemable(grant({ expiresAt: now }), now)?.code).toBe("expired");
  });

  it("allows a grant that has not expired yet", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    const later = new Date("2026-08-02T00:00:00Z");
    expect(checkRedeemable(grant({ expiresAt: later }), now)).toBeNull();
  });

  it("reports revocation before expiry or limit", () => {
    // A refunded buyer should be told access was withdrawn, not that they ran
    // out of downloads — the second invites a support ticket the merchant does
    // not want to receive.
    const refusal = checkRedeemable(
      grant({
        revokedAt: new Date(),
        revokedReason: "refunded",
        expiresAt: new Date(0),
        downloadLimit: 1,
        downloadCount: 9,
      }),
    );
    expect(refusal?.code).toBe("revoked");
    expect(refusal?.message).toContain("refunded");
  });

  it("gives a usable message when revoked without a stated reason", () => {
    const refusal = checkRedeemable(grant({ revokedAt: new Date() }));
    expect(refusal?.code).toBe("revoked");
    expect(refusal?.message.length).toBeGreaterThan(0);
  });
});

describe("expiryFor", () => {
  it("returns null for an unlimited policy", () => {
    expect(expiryFor(null)).toBeNull();
  });

  it("adds whole days", () => {
    const from = new Date("2026-08-01T12:00:00Z");
    expect(expiryFor(30, from)?.toISOString()).toBe("2026-08-31T12:00:00.000Z");
  });
});

describe("newGrantToken", () => {
  it("is long enough not to be guessable", () => {
    // 256 bits base64url. The token is the shopper's only credential, so a
    // short one makes the private bucket's protection decorative.
    expect(newGrantToken().length).toBeGreaterThanOrEqual(43);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newGrantToken()));
    expect(seen.size).toBe(500);
  });

  it("is URL-safe", () => {
    for (let i = 0; i < 50; i++) expect(newGrantToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
