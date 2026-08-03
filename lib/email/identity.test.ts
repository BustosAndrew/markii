import { describe, expect, it } from "vitest";
import { normalizeDomain } from "./identity";

/**
 * Domain normalisation.
 *
 * Merchants paste whatever is in their address bar. Each variant below is a
 * *different* SES identity or an outright rejection, and the failure surfaces
 * minutes later as a verification that simply never completes — so it is worth
 * getting right before anything reaches AWS. The accepted shape also mirrors
 * the `email_identities_domain_shape` CHECK, so a rejection is a message rather
 * than a 500 from the database.
 */
describe("normalizeDomain", () => {
  it("accepts a bare domain unchanged", () => {
    expect(normalizeDomain("acme.com")).toBe("acme.com");
    expect(normalizeDomain("mail.acme.co.uk")).toBe("mail.acme.co.uk");
  });

  it("strips a scheme, path, port and trailing dot", () => {
    expect(normalizeDomain("https://acme.com/")).toBe("acme.com");
    expect(normalizeDomain("http://www.acme.com/shop?x=1")).toBe("www.acme.com");
    expect(normalizeDomain("acme.com:443")).toBe("acme.com");
    expect(normalizeDomain("acme.com.")).toBe("acme.com");
  });

  it("takes the domain out of an email address", () => {
    // "orders@acme.com" is the single most common paste, and registering it
    // verbatim would fail at AWS with an unhelpful message.
    expect(normalizeDomain("orders@acme.com")).toBe("acme.com");
  });

  it("lowercases and trims", () => {
    expect(normalizeDomain("  ACME.Com  ")).toBe("acme.com");
  });

  it("rejects anything that is not a domain", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("acme")).toBeNull();
    expect(normalizeDomain("-acme.com")).toBeNull();
    expect(normalizeDomain("acme-.com")).toBeNull();
    expect(normalizeDomain("acme..com")).toBeNull();
    expect(normalizeDomain("acme .com")).toBeNull();
  });
});
