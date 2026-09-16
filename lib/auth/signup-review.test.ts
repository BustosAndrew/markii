import { describe, expect, it } from "vitest";
import { domainOf, signupBursts, type SignupRow } from "./signup-review";
import { signupReview } from "@/lib/email/templates/signup-review";

/**
 * The grouping behind the sign-up review digest (G12). Whether the cron sends
 * it is `tests/integration/signup-review.test.ts`.
 */

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 15, 8, minutes));
const row = (email: string, minutes: number, slug = email.split("@")[0]): SignupRow => ({
  slug,
  name: slug,
  billingEmail: email,
  createdAt: at(minutes),
});

describe("domainOf", () => {
  it("case-folds and trims", () => {
    expect(domainOf("  Me@Throwaway.Example ")).toBe("throwaway.example");
  });
  it("refuses anything not shaped like an address", () => {
    expect(domainOf("nobody")).toBeNull();
    expect(domainOf("@host")).toBeNull();
    expect(domainOf("me@")).toBeNull();
  });
});

describe("signupBursts", () => {
  it("reports only domains at or over the threshold, largest first", () => {
    const rows = [
      row("a1@burst.example", 1),
      row("a2@burst.example", 2),
      row("a3@burst.example", 3),
      row("b1@other.example", 4),
      row("b2@other.example", 5),
      row("c1@quiet.example", 6),
    ];
    const bursts = signupBursts(rows, 2);
    expect(bursts.map((b) => [b.domain, b.count])).toEqual([
      ["burst.example", 3],
      ["other.example", 2],
    ]);
  });

  it("is empty on a quiet day — the digest is the exceptions, not a report", () => {
    expect(signupBursts([row("a@x.example", 1), row("b@y.example", 2)], 2)).toEqual([]);
  });

  /** `A1@Burst.Example` and `a2@burst.example` are one host. */
  it("groups case-insensitively", () => {
    const bursts = signupBursts([row("A1@Burst.Example", 1), row("a2@burst.example", 2)], 2);
    expect(bursts).toHaveLength(1);
    expect(bursts[0].orgs.map((o) => o.email)).toEqual(["a1@burst.example", "a2@burst.example"]);
  });

  it("lists the orgs under a domain oldest first, whatever order they arrived in", () => {
    const bursts = signupBursts([row("late@h.example", 30), row("early@h.example", 5)], 2);
    expect(bursts[0].orgs.map((o) => o.slug)).toEqual(["early", "late"]);
  });

  /** Every staff account, seed and test fixture lives at the platform domain. */
  it("never reviews the platform's own domain, whatever the count", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((i) => row(`t${i}@Markii.Shop`, i));
    expect(signupBursts(rows, 2, ["markii.shop"])).toEqual([]);
    // The exclusion is exact: a look-alike is still reviewed.
    expect(signupBursts([row("a@markii.shop.example", 1), row("b@markii.shop.example", 2)], 2, ["markii.shop"])).toHaveLength(1);
  });

  it("skips a malformed address rather than pooling it", () => {
    expect(signupBursts([row("broken", 1), row("also-broken", 2)], 1)).toEqual([]);
  });
});

describe("signupReview template", () => {
  it("names every flagged org in both parts and says nothing was enforced", () => {
    const bursts = signupBursts(
      [row("a1@burst.example", 1), row("a2@burst.example", 2)],
      2,
    );
    const mail = signupReview({
      bursts,
      since: at(0),
      until: at(59),
      threshold: 2,
      totalSignups: 3,
    });
    expect(mail.subject).toBe("Sign-ups to review: 2 from burst.example");
    for (const part of [mail.html, mail.text]) {
      expect(part).toContain("a1@burst.example");
      expect(part).toContain("a2@burst.example");
      expect(part).toMatch(/nothing (here )?has been held or disabled/i);
    }
    expect(mail.text).toContain("3 merchant sign-ups");
  });
});
