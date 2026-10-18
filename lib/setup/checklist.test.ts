import { describe, expect, it } from "vitest";
import type { AccountStanding } from "../billing/standing";
import { setupChecklist, type SetupFacts, type SetupStepId } from "./checklist";

/**
 * The setup checklist (§28) — a pure function of the store's real state, so
 * every rule that decides "done" is checked here without a database.
 */

type Store = SetupFacts["stores"][number];

function store(overrides: Partial<Store> = {}): Store {
  return {
    id: 1,
    name: "Acme",
    slug: "acme",
    status: "draft",
    indexed: true,
    agentDiscovery: true,
    purchasesEnabled: true,
    paymentProviders: { x402: true, stripe: false },
    walletAddress: "0xabc",
    orgWalletAddress: null,
    customDomain: null,
    domainStatus: "none",
    enabledProductCount: 3,
    sellsShippable: false,
    shippingZoneCount: 0,
    emptyShippingZoneCount: 0,
    taxProvider: "none",
    manualTaxRateCount: 0,
    stripeConnected: false,
    locationCount: 1,
    hasVariantBackedProducts: false,
    stripeConfigured: true,
    emailProviderConfigured: true,
    customerEmailReady: false,
    taxConfigured: true,
    ...overrides,
  };
}

const trialing: AccountStanding = {
  state: "trialing",
  reason: "",
  endsAt: new Date("2026-11-01T00:00:00Z"),
  daysLeft: 14,
};

function facts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return {
    stores: [store()],
    standing: trialing,
    stripe: { chargesEnabled: false, requirementsDue: [] },
    productsWithIssues: new Map(),
    can: () => true,
    ...overrides,
  };
}

function stepOf(f: SetupFacts, id: SetupStepId, storeIndex = 0) {
  const c = setupChecklist(f);
  const s = c.stores[storeIndex]?.steps.find((x) => x.id === id) ?? c.account.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
}

describe("a brand-new account", () => {
  it("starts with creating a store, and nothing else is reachable yet", () => {
    const c = setupChecklist(facts({ stores: [] }));
    expect(c.firstRun).toBe(true);
    expect(c.complete).toBe(false);
    expect(c.next?.step.id).toBe("create_store");
    expect(c.stores).toEqual([]);
  });
});

describe("payments", () => {
  it("is done by x402 with a wallet on the store or the org", () => {
    expect(stepOf(facts(), "payments").status).toBe("done");
    expect(
      stepOf(facts({ stores: [store({ walletAddress: null, orgWalletAddress: "0xorg" })] }), "payments").status,
    ).toBe("done");
  });

  it("is not done by x402 with nowhere to send the money", () => {
    const s = stepOf(facts({ stores: [store({ walletAddress: null })] }), "payments");
    expect(s.status).toBe("todo");
    expect(s.detail).toMatch(/wallet/);
  });

  /** A connected account Stripe has not cleared cannot take a charge — the same gate checkout uses. */
  it("is not done by a connected Stripe account that cannot take charges yet, and says what Stripe wants", () => {
    const f = facts({
      stores: [store({ paymentProviders: { stripe: true }, stripeConnected: true })],
      stripe: { chargesEnabled: false, requirementsDue: ["individual.verification.document"] },
    });
    const s = stepOf(f, "payments");
    expect(s.status).toBe("todo");
    expect(s.detail).toContain("individual.verification.document");
  });

  it("is done by card once Stripe enables charges", () => {
    const f = facts({
      stores: [store({ paymentProviders: { stripe: true }, stripeConnected: true })],
      stripe: { chargesEnabled: true, requirementsDue: [] },
    });
    expect(stepOf(f, "payments")).toMatchObject({ status: "done", detail: "Taking payment by card (Stripe)." });
  });

  it("is not done while purchases are switched off, whatever the rails say", () => {
    const s = stepOf(facts({ stores: [store({ purchasesEnabled: false })] }), "payments");
    expect(s.status).toBe("todo");
    expect(s.href).toBe("/dashboard/websites/acme");
  });
});

describe("shipping", () => {
  it("is not needed for a store that ships nothing", () => {
    expect(stepOf(facts(), "shipping").status).toBe("not_needed");
  });

  it("needs a zone once something ships", () => {
    expect(stepOf(facts({ stores: [store({ sellsShippable: true })] }), "shipping").status).toBe("todo");
  });

  /** An empty zone looks configured and refuses checkout — readiness's critical, mirrored here. */
  it("is not done while any zone has no rates", () => {
    const s = stepOf(
      facts({ stores: [store({ sellsShippable: true, shippingZoneCount: 2, emptyShippingZoneCount: 1 })] }),
      "shipping",
    );
    expect(s.status).toBe("todo");
    expect(s.detail).toMatch(/1 shipping zone has no rates/);
  });

  it("is done when every zone quotes", () => {
    expect(
      stepOf(facts({ stores: [store({ sellsShippable: true, shippingZoneCount: 1 })] }), "shipping").status,
    ).toBe("done");
  });
});

describe("tax", () => {
  /** "None" is a legitimate answer — but one the merchant should give, not inherit. */
  it("is done once a choice is saved, including none", () => {
    expect(stepOf(facts(), "tax").status).toBe("done");
    expect(stepOf(facts({ stores: [store({ taxConfigured: false })] }), "tax").status).toBe("todo");
  });

  it("is not done by a choice that cannot calculate", () => {
    expect(
      stepOf(facts({ stores: [store({ taxProvider: "manual", manualTaxRateCount: 0 })] }), "tax").status,
    ).toBe("todo");
    expect(
      stepOf(facts({ stores: [store({ taxProvider: "stripe", stripeConnected: false })] }), "tax").status,
    ).toBe("todo");
  });
});

describe("going live", () => {
  it("names what is left before a draft can launch", () => {
    const f = facts({ stores: [store({ enabledProductCount: 0, taxConfigured: false })] });
    const s = stepOf(f, "go_live");
    expect(s.status).toBe("todo");
    expect(s.detail).toMatch(/add products, decide on tax/);
    expect(setupChecklist(f).stores[0].readyToLaunch).toBe(false);
  });

  it("is ready to launch when only going live remains", () => {
    const c = setupChecklist(facts());
    expect(c.stores[0].readyToLaunch).toBe(true);
    expect(c.stores[0].requiredRemaining).toBe(1);
    expect(c.next?.step.id).toBe("go_live");
  });

  it("completes setup once live, and stops being a first run", () => {
    const c = setupChecklist(facts({ stores: [store({ status: "live" })], standing: null }));
    expect(c.firstRun).toBe(false);
    expect(c.complete).toBe(true);
  });

  /** A paused store has been live — it is not a new merchant, though it is not serving. */
  it("treats a paused store as not a first run but not done either", () => {
    const c = setupChecklist(facts({ stores: [store({ status: "paused" })] }));
    expect(c.firstRun).toBe(false);
    expect(stepOf(facts({ stores: [store({ status: "paused" })] }), "go_live").detail).toMatch(/paused/);
  });
});

describe("optional steps never block launch", () => {
  it("leaves readyToLaunch true with catalog gaps, no sending domain and no custom domain", () => {
    const c = setupChecklist(facts({ productsWithIssues: new Map([[1, 4]]) }));
    const optional = c.stores[0].steps.filter((s) => !s.required);
    expect(optional.map((s) => s.id).sort()).toEqual(["custom_domain", "customer_email", "polish_catalog"]);
    expect(optional.every((s) => s.status === "todo")).toBe(true);
    expect(c.stores[0].readyToLaunch).toBe(true);
  });

  it("points catalog gaps at the Catalog agent", () => {
    const s = stepOf(facts({ productsWithIssues: new Map([[1, 4]]) }), "polish_catalog");
    expect(s.agent).toBe("catalog");
    expect(s.detail).toMatch(/^4 products have/);
  });

  /** Markii's missing email provider is ours, not the merchant's — readiness raises nothing either. */
  it("does not hand the merchant Markii's own missing email provider", () => {
    expect(
      stepOf(facts({ stores: [store({ emailProviderConfigured: false })] }), "customer_email").status,
    ).toBe("not_needed");
  });
});

describe("the account", () => {
  it("counts down the free month without blocking setup", () => {
    const c = setupChecklist(facts());
    const plan = c.account.find((s) => s.id === "choose_plan")!;
    expect(plan.status).toBe("todo");
    expect(plan.detail).toMatch(/^14 days left/);
    expect(c.next?.step.id).toBe("go_live");
  });

  it("puts a held account first, ahead of every store step", () => {
    const expired: AccountStanding = { state: "expired", reason: "", endedAt: new Date() };
    const c = setupChecklist(facts({ standing: expired, stores: [store({ status: "live" })] }));
    expect(c.next?.step.id).toBe("choose_plan");
    expect(c.complete).toBe(false);
  });

  it("does not offer a plan to a suspended account — paying does not lift a suspension", () => {
    const suspended: AccountStanding = { state: "suspended", reason: "x", since: new Date() };
    const plan = setupChecklist(facts({ standing: suspended })).account.find((s) => s.id === "choose_plan")!;
    expect(plan.title).toMatch(/support/i);
  });
});

describe("canAct", () => {
  /** A viewer is told who can do a step, rather than sent to a page that refuses them. */
  it("answers each step from the asker's permissions", () => {
    const c = setupChecklist(facts({ can: (p) => p === "catalog.write" }));
    const steps = c.stores[0].steps;
    expect(steps.find((s) => s.id === "add_products")!.canAct).toBe(true);
    expect(steps.find((s) => s.id === "payments")!.canAct).toBe(false);
  });
});

describe("the next step", () => {
  it("finishes a draft store before polishing a live one", () => {
    const c = setupChecklist(
      facts({
        stores: [store({ id: 1, status: "live" }), store({ id: 2, slug: "two", taxConfigured: false })],
        productsWithIssues: new Map([[1, 2]]),
      }),
    );
    expect(c.next).toMatchObject({ siteId: 2, step: { id: "tax" } });
  });
});

describe("links", () => {
  /** Every href a step can carry, across the states that change it. */
  it("names only dashboard pages that exist", async () => {
    const { dashboardPageExists } = await import("../../tests/stubs/dashboard-routes");
    const variants = [
      facts({ stores: [] }),
      facts(),
      facts({ stores: [store({ purchasesEnabled: false, sellsShippable: true })] }),
    ];
    const hrefs = new Set(
      variants.flatMap((f) => {
        const c = setupChecklist(f);
        return [...c.account, ...c.stores.flatMap((s) => s.steps)].map((s) => s.href);
      }),
    );
    for (const href of hrefs) expect(dashboardPageExists(href), href).toBe(true);
    expect(dashboardPageExists("/dashboard/no-such-page")).toBe(false);
  });
});
