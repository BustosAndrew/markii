import type { Permission } from "../auth/permissions";
import type { AccountStanding } from "../billing/standing";
import type { StoreFacts } from "../readiness/rules";

/**
 * The first-run setup checklist (§28) — what stands between a merchant and a
 * store that can take an order.
 *
 * **Derived on every read, never stored**, for the reason readiness issues are
 * (§9): a stored "done" goes stale the moment someone deletes the last shipping
 * rate, and a merchant who just connected Stripe should not wait for a job to
 * notice. Nothing here can be ticked off by hand — a step is done when the
 * store says it is.
 *
 * **Built on readiness's own facts** (`StoreFacts`), so the checklist and the
 * Health page cannot disagree about whether a store can take payment. Pure:
 * the loader is `./index`, and every rule here is unit-tested without a
 * database.
 */

export type SetupStepId =
  | "create_store"
  | "add_products"
  | "payments"
  | "shipping"
  | "tax"
  | "go_live"
  | "polish_catalog"
  | "customer_email"
  | "custom_domain"
  | "choose_plan";

/**
 * `not_needed` is a real answer, not a skipped check: a store selling only
 * downloads has no shipping step, and showing one would teach merchants that
 * the list cries wolf.
 */
export type SetupStepStatus = "done" | "todo" | "not_needed";

/** Merchant agents that can help with a step. Mirrors `AgentKind` without importing the schema. */
export type SetupAgent = "catalog" | "assistant";

export type SetupStep = {
  id: SetupStepId;
  title: string;
  status: SetupStepStatus;
  /** Required to launch. Optional steps are recommendations and never block `readyToLaunch`. */
  required: boolean;
  /** What is true right now, in the merchant's terms — never a promise of an outcome. */
  detail: string;
  /** The dashboard page where the step is done. Always a real route (a unit test checks). */
  href: string;
  /** What doing it needs — the registry action's or route's own permission. */
  permission: Permission;
  /** Whether the asker's role holds `permission`. False → "ask an owner or administrator". */
  canAct: boolean;
  /** An agent that can do part of the work, as proposals the merchant approves. */
  agent: SetupAgent | null;
};

export type StoreSetup = {
  siteId: number;
  name: string;
  status: StoreFacts["status"];
  steps: SetupStep[];
  /** Required steps not yet done — the number a progress bar counts down. */
  requiredRemaining: number;
  /** Every required step other than going live is done. */
  readyToLaunch: boolean;
};

export type SetupChecklist = {
  /**
   * No store has ever gone live (none is `live` or `paused`). The signal for a
   * screen to lead with setup and open the assistant — not an onboarding flag
   * someone has to remember to clear.
   */
  firstRun: boolean;
  /** Org-level steps: creating the first store, and choosing a plan. */
  account: SetupStep[];
  stores: StoreSetup[];
  /** The single most useful thing to do next, or null when nothing required remains. */
  next: { siteId: number | null; step: SetupStep } | null;
  /** Every reachable store is live with nothing required outstanding, and the account is not held. */
  complete: boolean;
};

export type SetupFacts = {
  stores: (StoreFacts & {
    slug: string;
    /** A `tax_settings` row exists — the merchant made a choice, even if the choice was "none". */
    taxConfigured: boolean;
  })[];
  standing: AccountStanding | null;
  stripe: {
    /** Connected, and Stripe says the account can take charges — the only honest card gate. */
    chargesEnabled: boolean;
    /** Stripe's outstanding requirements on a connected account, verbatim. */
    requirementsDue: string[];
  };
  /** Distinct products per store with an open critical or warning readiness finding. */
  productsWithIssues: Map<number, number>;
  /** Whether the asker's role holds a permission. */
  can: (permission: Permission) => boolean;
};

type StepInput = Omit<SetupStep, "canAct">;

function step(facts: SetupFacts, s: StepInput): SetupStep {
  return { ...s, canAct: facts.can(s.permission) };
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The plan step, from account standing. Separate from launch: a trialing store is fully live. */
function planStep(facts: SetupFacts): SetupStep {
  const base = {
    id: "choose_plan" as const,
    title: "Choose a plan",
    required: false,
    href: "/dashboard/billing",
    permission: "billing.write" as const,
    agent: null,
  };
  const s = facts.standing;
  if (!s || s.state === "subscribed" || s.state === "ungated") {
    return step(facts, { ...base, status: "done", detail: "Your subscription is active." });
  }
  switch (s.state) {
    case "trialing":
      return step(facts, {
        ...base,
        status: "todo",
        detail:
          s.daysLeft === 0
            ? "Your free month ends today. Choose a plan to keep the storefront running."
            : `${plural(s.daysLeft, "day")} left in your free month. No card is needed until you choose a plan.`,
      });
    case "expired":
      return step(facts, {
        ...base,
        status: "todo",
        detail:
          "Your free month has ended, so the storefront is offline and changes are on hold. " +
          "Choosing a plan brings it back; your catalog, orders and customers are untouched.",
      });
    case "past_due":
      return step(facts, {
        ...base,
        title: "Update your payment method",
        status: "todo",
        detail: "A renewal payment is failing. Update the card and Stripe will retry the invoice.",
      });
    case "suspended":
      return step(facts, {
        ...base,
        title: "Contact Markii support",
        status: "todo",
        detail: "This account is on hold by Markii. Contact support — choosing a plan will not lift it.",
      });
  }
}

/** Whether a store has at least one rail that can actually take money today. */
function paymentsStep(facts: SetupFacts, s: SetupFacts["stores"][number]): SetupStep {
  const base = {
    id: "payments" as const,
    title: "Set up payments",
    required: true,
    href: "/dashboard/payments",
    permission: "billing.write" as const,
    agent: null,
  };

  const x402Works = Boolean(s.paymentProviders.x402 && (s.walletAddress || s.orgWalletAddress));
  const cardWorks = Boolean(
    s.paymentProviders.stripe && s.stripeConfigured && s.stripeConnected && facts.stripe.chargesEnabled,
  );

  if (!s.purchasesEnabled) {
    return step(facts, {
      ...base,
      status: "todo",
      detail: "Purchases are switched off for this store, so nothing can be bought yet.",
      href: `/dashboard/websites/${s.slug}`,
      permission: "cms.write",
    });
  }
  if (x402Works || cardWorks) {
    const rails = [cardWorks && "card (Stripe)", x402Works && "x402 (USDC)"].filter(Boolean);
    return step(facts, { ...base, status: "done", detail: `Taking payment by ${rails.join(" and ")}.` });
  }

  let detail = "No payment method is enabled for this store.";
  if (s.paymentProviders.stripe && s.stripeConnected && !facts.stripe.chargesEnabled) {
    detail =
      "Your Stripe account is connected but Stripe has not enabled charges yet" +
      (facts.stripe.requirementsDue.length
        ? ` — it is waiting on: ${facts.stripe.requirementsDue.join(", ")}.`
        : ". Finish verification in your Stripe dashboard.");
  } else if (s.paymentProviders.stripe && !s.stripeConfigured) {
    detail = "Card payments are switched on, but they are not available on this platform yet.";
  } else if (s.paymentProviders.stripe && !s.stripeConnected) {
    detail = "Card payments are switched on, but no Stripe account is connected.";
  } else if (s.paymentProviders.x402) {
    detail = "x402 is switched on, but there is no receiving wallet address.";
  }
  return step(facts, { ...base, status: "todo", detail });
}

function storeSteps(facts: SetupFacts, s: SetupFacts["stores"][number]): SetupStep[] {
  const hasProducts = s.enabledProductCount > 0;
  const steps: SetupStep[] = [];

  steps.push(
    step(facts, {
      id: "add_products",
      title: "Add products",
      required: true,
      status: hasProducts ? "done" : "todo",
      detail: hasProducts
        ? `${plural(s.enabledProductCount, "product")} on sale.`
        : "No products are on sale yet. Add one, or import a catalog from Shopify or WooCommerce.",
      href: "/dashboard/products/new",
      permission: "catalog.write",
      agent: null,
    }),
  );

  steps.push(paymentsStep(facts, s));

  if (!s.sellsShippable) {
    steps.push(
      step(facts, {
        id: "shipping",
        title: "Set up shipping",
        required: true,
        status: "not_needed",
        detail: hasProducts
          ? "Nothing on this store needs shipping."
          : "Needed once you sell something that ships.",
        href: "/dashboard/settings/shipping",
        permission: "commerce.write",
        agent: null,
      }),
    );
  } else {
    const ready = s.shippingZoneCount > 0 && s.emptyShippingZoneCount === 0;
    steps.push(
      step(facts, {
        id: "shipping",
        title: "Set up shipping",
        required: true,
        status: ready ? "done" : "todo",
        detail: ready
          ? `${plural(s.shippingZoneCount, "shipping zone")}, each with a rate.`
          : s.shippingZoneCount === 0
            ? "You sell goods that ship but have no shipping zones, so checkout is refused rather than quoting zero postage."
            : `${plural(s.emptyShippingZoneCount, "shipping zone")} ${s.emptyShippingZoneCount === 1 ? "has" : "have"} no rates, which refuses checkout to those destinations.`,
        href: "/dashboard/settings/shipping",
        permission: "commerce.write",
        agent: null,
      }),
    );
  }

  /**
   * Tax is a decision, so it is done when one has been made — including
   * "none". The default charges no tax, and a merchant should arrive at that
   * on purpose rather than by never opening the page. A choice that cannot
   * calculate is not done, matching the readiness rules for the same cases.
   */
  let taxDone = s.taxConfigured;
  let taxDetail = "Choose how tax is charged: none, your own rates, or Stripe Tax.";
  if (s.taxConfigured && s.taxProvider === "manual" && s.manualTaxRateCount === 0) {
    taxDone = false;
    taxDetail = "Tax is set to manual rates but none are configured, so every checkout is refused.";
  } else if (s.taxConfigured && s.taxProvider === "stripe" && !s.stripeConnected) {
    taxDone = false;
    taxDetail = "Tax is set to Stripe Tax, which needs a connected Stripe account.";
  } else if (s.taxConfigured) {
    taxDetail =
      s.taxProvider === "none"
        ? "Set to charge no tax."
        : s.taxProvider === "manual"
          ? `${plural(s.manualTaxRateCount, "manual tax rate")} configured.`
          : "Calculated by Stripe Tax on your Stripe account.";
  }
  steps.push(
    step(facts, {
      id: "tax",
      title: "Decide on tax",
      required: true,
      status: taxDone ? "done" : "todo",
      detail: taxDetail,
      href: "/dashboard/settings/tax",
      permission: "commerce.write",
      agent: null,
    }),
  );

  const prerequisites = steps.filter((x) => x.required && x.status === "todo");
  steps.push(
    step(facts, {
      id: "go_live",
      title: "Put the store live",
      required: true,
      status: s.status === "live" ? "done" : "todo",
      detail:
        s.status === "live"
          ? "The storefront is live."
          : s.status === "paused"
            ? "The storefront is paused, so shoppers see it as unavailable."
            : prerequisites.length
              ? `Still a draft. Finish ${prerequisites.map((x) => x.title.toLowerCase()).join(", ")} first.`
              : "Everything it needs is in place. Publishing makes the storefront public.",
      href: `/dashboard/websites/${s.slug}`,
      permission: "cms.write",
      agent: null,
    }),
  );

  const withIssues = facts.productsWithIssues.get(s.id) ?? 0;
  steps.push(
    step(facts, {
      id: "polish_catalog",
      title: "Fill catalog gaps",
      required: false,
      status: hasProducts && withIssues === 0 ? "done" : "todo",
      detail: !hasProducts
        ? "Add products first."
        : withIssues === 0
          ? "No open readiness findings on your products."
          : `${plural(withIssues, "product")} ${withIssues === 1 ? "has" : "have"} open readiness findings — missing descriptions, images, SKUs and the like.`,
      href: "/dashboard/catalog",
      permission: "catalog.write",
      agent: "catalog",
    }),
  );

  /**
   * Mail sends either way (D44), so this is a recommendation. When Markii's
   * own email provider is missing it is ours to fix, and the step is not
   * shown as the merchant's — the same rule readiness applies.
   */
  steps.push(
    step(facts, {
      id: "customer_email",
      title: "Send email from your own domain",
      required: false,
      status: !s.emailProviderConfigured ? "not_needed" : s.customerEmailReady ? "done" : "todo",
      detail: !s.emailProviderConfigured
        ? "Customer email is not available on this platform yet."
        : s.customerEmailReady
          ? "Order emails go from your verified domain."
          : "Order emails are sending from your store's Markii address. Verify your own domain so they come from you.",
      href: "/dashboard/settings/email",
      permission: "org.write",
      agent: null,
    }),
  );

  steps.push(
    step(facts, {
      id: "custom_domain",
      title: "Connect a custom domain",
      required: false,
      status: s.domainStatus === "verified" ? "done" : "todo",
      detail:
        s.domainStatus === "verified"
          ? `Serving at ${s.customDomain}.`
          : s.domainStatus === "pending"
            ? `${s.customDomain} is waiting for its DNS TXT record to be found.`
            : "Optional. Your store already has its own Markii address.",
      href: "/dashboard/settings/domains",
      permission: "cms.write",
      agent: null,
    }),
  );

  return steps;
}

export function setupChecklist(facts: SetupFacts): SetupChecklist {
  const plan = planStep(facts);
  const held =
    facts.standing?.state === "expired" ||
    facts.standing?.state === "suspended" ||
    facts.standing?.state === "past_due";

  const account: SetupStep[] = [
    step(facts, {
      id: "create_store",
      title: "Create your store",
      required: true,
      status: facts.stores.length > 0 ? "done" : "todo",
      detail:
        facts.stores.length > 0
          ? `${plural(facts.stores.length, "store")}.`
          : "Create a storefront — start from scratch or import an existing catalog.",
      href: "/dashboard/websites/new",
      permission: "cms.write",
      agent: null,
    }),
    plan,
  ];

  const stores: StoreSetup[] = facts.stores.map((s) => {
    const steps = storeSteps(facts, s);
    const remaining = steps.filter((x) => x.required && x.status === "todo");
    return {
      siteId: s.id,
      name: s.name,
      status: s.status,
      steps,
      requiredRemaining: remaining.length,
      readyToLaunch: remaining.every((x) => x.id === "go_live"),
    };
  });

  /**
   * Next step, in order of what blocks most: a held account blocks
   * everything; no store blocks every store step; then each store's required
   * steps in order, live stores last (a paused store is still a store to
   * finish); then recommendations.
   */
  let next: SetupChecklist["next"] = null;
  if (held) next = { siteId: null, step: plan };
  else if (account[0].status === "todo") next = { siteId: null, step: account[0] };
  else {
    const ordered = [...stores].sort((a, b) => Number(a.status === "live") - Number(b.status === "live"));
    for (const store of ordered) {
      const todo = store.steps.find((x) => x.required && x.status === "todo");
      if (todo) {
        next = { siteId: store.siteId, step: todo };
        break;
      }
    }
    if (!next && plan.status === "todo") next = { siteId: null, step: plan };
    if (!next) {
      for (const store of ordered) {
        const todo = store.steps.find((x) => x.status === "todo");
        if (todo) {
          next = { siteId: store.siteId, step: todo };
          break;
        }
      }
    }
  }

  return {
    firstRun: !facts.stores.some((s) => s.status !== "draft"),
    account,
    stores,
    next,
    complete:
      !held && stores.length > 0 && stores.every((s) => s.requiredRemaining === 0),
  };
}
