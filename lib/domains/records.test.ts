import { afterEach, describe, expect, it } from "vitest";
import { normalizeDomain } from "./normalize";
import {
  dnsRecordsFor,
  generateVerificationToken,
  looksLikeApex,
  ownershipRecordName,
  ownershipRecordValue,
  pointsHere,
  txtCarriesToken,
} from "./records";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe("normalizeDomain", () => {
  it("reduces what merchants actually paste to a bare hostname", () => {
    expect(normalizeDomain("https://shop.acme.com/")).toBe("shop.acme.com");
    expect(normalizeDomain("  Shop.Acme.com. ")).toBe("shop.acme.com");
    expect(normalizeDomain("shop.acme.com:443")).toBe("shop.acme.com");
  });

  it("rejects anything that is not a hostname", () => {
    // Mirrors the `sites_custom_domain_shape` CHECK, so a bad paste is a message
    // rather than a 500 from the database.
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("-acme.com")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
  });
});

describe("txtCarriesToken", () => {
  const token = "0123456789abcdef0123456789abcdef";

  it("matches the published record", () => {
    expect(txtCarriesToken([[ownershipRecordValue(token)]], token)).toBe(true);
  });

  it("joins chunks before comparing", () => {
    /**
     * A TXT value over 255 bytes comes back split, and comparing chunk by chunk
     * would reject a correctly published record — a failure the merchant could
     * do nothing about because their DNS is right.
     */
    const value = ownershipRecordValue(token);
    const split = [value.slice(0, 10), value.slice(10)];
    expect(txtCarriesToken([split], token)).toBe(true);
  });

  it("ignores unrelated records on the same name", () => {
    expect(
      txtCarriesToken([["v=spf1 include:example.com ~all"], [ownershipRecordValue(token)]], token),
    ).toBe(true);
    expect(txtCarriesToken([["v=spf1 -all"]], token)).toBe(false);
  });

  it("refuses another site's token", () => {
    // The whole gate. A near-miss must not verify, or ownership means nothing.
    expect(txtCarriesToken([[ownershipRecordValue("f".repeat(32))]], token)).toBe(false);
  });
});

describe("generateVerificationToken", () => {
  it("is 128 bits of hex and does not repeat", () => {
    // A guessable token published on an attacker's own domain would verify a
    // hostname they do not control, so this is a security property, not a detail.
    const tokens = new Set(Array.from({ length: 200 }, generateVerificationToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("dnsRecordsFor", () => {
  it("always leads with the ownership record", () => {
    const [first] = dnsRecordsFor("shop.acme.com", "tok");
    expect(first).toMatchObject({
      type: "TXT",
      name: "_markii-verify.shop.acme.com",
      purpose: "ownership",
    });
  });

  it("suggests a CNAME for a subdomain and A records for an apex", () => {
    expect(dnsRecordsFor("shop.acme.com", "tok").map((r) => r.type)).toEqual(["TXT", "CNAME"]);
    expect(dnsRecordsFor("acme.com", "tok").map((r) => r.type)).toEqual(["TXT", "A"]);
  });

  it("honours a configured target so a self-hosted deployment is not told to use Vercel", () => {
    process.env.SITE_DOMAIN_CNAME_TARGET = "edge.example.net";
    expect(dnsRecordsFor("shop.acme.com", "tok")[1].value).toBe("edge.example.net");
  });
});

describe("looksLikeApex", () => {
  it("is only a hint about which record to suggest first", () => {
    expect(looksLikeApex("acme.com")).toBe(true);
    expect(looksLikeApex("shop.acme.com")).toBe(false);
    /**
     * Wrong for `acme.co.uk`, and deliberately not fixed with a public-suffix
     * list: this decides presentation order only. `pointsHere` accepts either
     * record regardless, so being wrong here costs a merchant nothing.
     */
    expect(looksLikeApex("acme.co.uk")).toBe(false);
  });
});

describe("pointsHere", () => {
  it("accepts either record, and neither gates verification", () => {
    process.env.SITE_DOMAIN_CNAME_TARGET = "edge.example.net";
    process.env.SITE_DOMAIN_A_RECORD = "203.0.113.7";
    expect(pointsHere({ cname: ["edge.example.net."], a: [] })).toBe(true);
    expect(pointsHere({ cname: [], a: ["203.0.113.7"] })).toBe(true);
    expect(pointsHere({ cname: ["elsewhere.example.org"], a: ["198.51.100.1"] })).toBe(false);
    expect(pointsHere({ cname: [], a: [] })).toBe(false);
  });

  it("reads a comma-separated list of A records", () => {
    process.env.SITE_DOMAIN_A_RECORD = "203.0.113.7, 203.0.113.8";
    expect(pointsHere({ cname: [], a: ["203.0.113.8"] })).toBe(true);
  });

  it("accepts the target's live addresses when none are configured", () => {
    /**
     * The bug this closes. The hardcoded default was Vercel's documented
     * `76.76.21.21` while the deployment's own apex answered on a different
     * address — so a merchant who pointed their apex correctly was told it was
     * wrong. A false negative on someone who did everything right.
     */
    delete process.env.SITE_DOMAIN_A_RECORD;
    expect(pointsHere({ cname: [], a: ["216.198.79.1"] }, ["216.198.79.1"])).toBe(true);
    expect(pointsHere({ cname: [], a: ["198.51.100.1"] }, ["216.198.79.1"])).toBe(false);
  });

  it("lets an explicit configuration override live resolution", () => {
    // A deployment that has stated its addresses means them; resolving must not
    // quietly widen what it accepts.
    process.env.SITE_DOMAIN_A_RECORD = "203.0.113.7";
    expect(pointsHere({ cname: [], a: ["203.0.113.7"] }, ["216.198.79.1"])).toBe(true);
    expect(pointsHere({ cname: [], a: ["216.198.79.1"] }, ["216.198.79.1"])).toBe(false);
  });

  it("falls back to the documented address when resolution fails", () => {
    // Showing an apex no record at all is worse than showing a possibly stale one.
    delete process.env.SITE_DOMAIN_A_RECORD;
    expect(pointsHere({ cname: [], a: ["76.76.21.21"] }, [])).toBe(true);
  });
});

describe("instruction and check agree", () => {
  it("suggests exactly the addresses it will accept", () => {
    /**
     * The property that matters more than either half: telling a merchant to
     * publish one address and then rejecting it is the failure mode this whole
     * change exists to remove. Same source, so they cannot disagree.
     */
    delete process.env.SITE_DOMAIN_A_RECORD;
    const resolved = ["216.198.79.1", "76.76.21.93"];
    const suggested = dnsRecordsFor("acme.com", "tok", resolved)
      .filter((r) => r.type === "A")
      .map((r) => r.value);
    expect(suggested).toEqual(resolved);
    for (const ip of suggested) {
      expect(pointsHere({ cname: [], a: [ip] }, resolved), `${ip} was suggested`).toBe(true);
    }
  });
});

describe("ownershipRecordName", () => {
  it("is underscore-prefixed so it cannot collide with a real host", () => {
    expect(ownershipRecordName("acme.com")).toBe("_markii-verify.acme.com");
  });
});
