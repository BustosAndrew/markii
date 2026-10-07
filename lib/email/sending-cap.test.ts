import { describe, expect, it } from "vitest";
import {
  ESTABLISHED_AFTER_DAYS,
  REPUTATION,
  SENDING_CAPS,
  cappedReason,
  reputationAtRisk,
  sendingCapFor,
  type SendingCapInput,
} from "./sending-cap";

/**
 * The merchant sending cap (G12) — who gets which ceiling.
 *
 * Every mistake here is silent in one of two directions: a tier decided wrong
 * either lets an unknown account blast the shared SES reputation, or stops an
 * established store's receipts. Neither throws.
 */

const NOW = new Date("2026-10-07T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const clean = { sent: 0, bounced: 0, complained: 0 };

function input(over: Partial<SendingCapInput> = {}): SendingCapInput {
  return {
    paying: true,
    accountCreatedAt: new Date(NOW.getTime() - 90 * DAY),
    sentLast24h: 0,
    history: clean,
    now: NOW,
    ...over,
  };
}

describe("tiers", () => {
  it("leaves an established, paying, clean account uncapped", () => {
    const cap = sendingCapFor(input({ sentLast24h: 50_000 }));
    expect(cap.tier).toBe("established");
    expect(cap.dailyLimit).toBeNull();
    expect(cap.remaining).toBeNull();
    expect(cap.allowed).toBe(true);
  });

  it("caps an account with no paying subscription at the trial cap", () => {
    const cap = sendingCapFor(input({ paying: false }));
    expect(cap.tier).toBe("trial");
    expect(cap.dailyLimit).toBe(SENDING_CAPS.trial);
  });

  /**
   * Age alone does not establish an account that has never paid. An org that
   * signed up a year ago and never subscribed is still one email address of
   * investment.
   */
  it("keeps an old account that never paid on the trial cap", () => {
    const cap = sendingCapFor(
      input({ paying: false, accountCreatedAt: new Date(NOW.getTime() - 400 * DAY) }),
    );
    expect(cap.tier).toBe("trial");
  });

  it("gives a paying account younger than the established age the new-account cap", () => {
    const cap = sendingCapFor(input({ accountCreatedAt: new Date(NOW.getTime() - 3 * DAY) }));
    expect(cap.tier).toBe("new");
    expect(cap.dailyLimit).toBe(SENDING_CAPS.new);
    expect(cap.reason).toContain(`lifts in ${ESTABLISHED_AFTER_DAYS - 3} days`);
  });

  it("establishes on the day the age is reached, not the day after", () => {
    const cap = sendingCapFor(
      input({ accountCreatedAt: new Date(NOW.getTime() - ESTABLISHED_AFTER_DAYS * DAY) }),
    );
    expect(cap.tier).toBe("established");
  });

  it("raises the cap for paying accounts — the new cap is above the trial cap", () => {
    expect(SENDING_CAPS.new!).toBeGreaterThan(SENDING_CAPS.trial!);
  });
});

describe("reputation", () => {
  /** Reputation outranks tenure: an old account mailing a bad list is the case the cap exists for. */
  it("puts an established account with a high bounce rate on probation", () => {
    const cap = sendingCapFor(input({ history: { sent: 1000, bounced: 60, complained: 0 } }));
    expect(cap.tier).toBe("probation");
    expect(cap.dailyLimit).toBe(SENDING_CAPS.probation);
  });

  it("puts an account at the AWS complaint review rate on probation", () => {
    const cap = sendingCapFor(input({ history: { sent: 1000, bounced: 0, complained: 1 } }));
    expect(cap.tier).toBe("probation");
  });

  it("does not judge below the minimum sample", () => {
    // The first bounce of a merchant's first ten sends is a 10% rate — and noise.
    const history = { sent: REPUTATION.minSample - 1, bounced: 10, complained: 3 };
    expect(reputationAtRisk(history)).toBe(false);
    expect(sendingCapFor(input({ history })).tier).toBe("established");
  });

  it("stays clean just under both rates", () => {
    expect(reputationAtRisk({ sent: 10_000, bounced: 499, complained: 9 })).toBe(false);
  });

  it("says why, with the numbers", () => {
    const cap = sendingCapFor(input({ history: { sent: 200, bounced: 20, complained: 0 } }));
    expect(cap.reason).toContain("200");
    expect(cap.reason).toContain("20 bounced");
  });
});

describe("the count", () => {
  /**
   * `sentLast24h` is what already left, so at the cap the next send is refused.
   * Getting this backwards lets one extra message out per merchant per day —
   * small, and exactly the kind of thing nobody notices until it matters.
   */
  it("allows the last send under the cap and refuses at it", () => {
    const limit = SENDING_CAPS.trial!;
    const under = sendingCapFor(input({ paying: false, sentLast24h: limit - 1 }));
    expect(under.allowed).toBe(true);
    expect(under.remaining).toBe(1);

    const at = sendingCapFor(input({ paying: false, sentLast24h: limit }));
    expect(at.allowed).toBe(false);
    expect(at.remaining).toBe(0);
  });

  it("floors remaining at zero when over", () => {
    const cap = sendingCapFor(input({ paying: false, sentLast24h: SENDING_CAPS.trial! + 40 }));
    expect(cap.remaining).toBe(0);
  });

  it("explains a refusal with the count and what lifts it", () => {
    const cap = sendingCapFor(input({ paying: false, sentLast24h: SENDING_CAPS.trial! }));
    const reason = cappedReason(cap);
    expect(reason).toContain(`${SENDING_CAPS.trial} of ${SENDING_CAPS.trial}`);
    expect(reason).toContain("Subscribing raises it");
  });
});
