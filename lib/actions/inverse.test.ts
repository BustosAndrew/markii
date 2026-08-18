import { describe, expect, it } from "vitest";
import "./index";
import { patchInverse } from "./inverse";
import { allActions, getAction } from "./registry";
import type { DiffEntry, RecordedInvocation } from "./types";

/**
 * Inverse reconstruction (§22 undo).
 *
 * These are pure: an `inverse` may read only the audit record, never the
 * database, which is exactly what makes it testable without one. Everything
 * here would otherwise need the integration suite and a real invocation.
 */

function recorded(partial: Partial<RecordedInvocation>): RecordedInvocation {
  return {
    invocationId: "inv_test",
    actionId: "test.action",
    input: {},
    result: null,
    diff: [],
    ...partial,
  };
}

const entry = (path: string, before: unknown, after: unknown, entityId = "7"): DiffEntry => ({
  entity: "variant",
  entityId,
  path,
  before,
  after,
});

describe("patchInverse", () => {
  const inverse = patchInverse({ actionId: "catalog.updateVariant", idField: "variantId" });

  it("replays the recorded before values against the same row", () => {
    const result = inverse(
      recorded({
        diff: [entry("priceMinor", 1500, 1200), entry("sku", "OLD-1", "NEW-1")],
      }),
    );

    expect(result).toEqual({
      actionId: "catalog.updateVariant",
      input: { variantId: 7, priceMinor: 1500, sku: "OLD-1" },
    });
  });

  it("restores a null, which is a value and not an absence", () => {
    // `sku: undefined` would be dropped by the action as "no change supplied",
    // silently leaving the SKU the undo was meant to clear.
    const result = inverse(recorded({ diff: [entry("sku", null, "NEW-1")] }));
    expect((result?.input as Record<string, unknown>).sku).toBeNull();
  });

  it("refuses an empty diff rather than invoking with only an id", () => {
    expect(inverse(recorded({ diff: [] }))).toBeNull();
  });

  it("refuses a diff spanning several rows", () => {
    // This helper encodes "one row per invocation". A bulk action that reused it
    // would silently restore the first row's values onto whichever id won.
    const result = inverse(
      recorded({ diff: [entry("priceMinor", 1, 2, "7"), entry("priceMinor", 3, 4, "8")] }),
    );
    expect(result).toBeNull();
  });

  it("maps a recorded column back to the input field that writes it", () => {
    const mapped = patchInverse({
      actionId: "catalog.updateCollection",
      idField: "collectionId",
      map: { publishedAt: (before) => ({ published: before !== null }) },
    });

    const result = mapped(
      recorded({
        diff: [
          { entity: "collection", entityId: "3", path: "publishedAt", before: null, after: "x" },
        ],
      }),
    );

    // Not `publishedAt: null` — the schema would strip that and undo would
    // report success while leaving the collection published.
    expect(result?.input).toEqual({ collectionId: 3, published: false });
  });

  it("is wired into catalog.updateCollection with that mapping", () => {
    /**
     * Against the real definition, not a locally built helper. The helper-level
     * test above passed with the mapping deleted from the action, which is the
     * whole bug it was supposed to catch: what matters is that the *shipped*
     * action carries it.
     */
    const result = getAction("catalog.updateCollection")?.inverse?.(
      recorded({
        diff: [
          {
            entity: "collection",
            entityId: "3",
            path: "publishedAt",
            before: null,
            after: "2026-08-18T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(result?.input).toEqual({ collectionId: 3, published: false });
  });

  it("lets a mapper refuse a value that cannot be expressed as input", () => {
    const mapped = patchInverse({
      actionId: "catalog.updateVariant",
      idField: "variantId",
      map: { priceMinor: () => null },
    });
    expect(mapped(recorded({ diff: [entry("priceMinor", 1, 2)] }))).toBeNull();
  });

  it("carries a required-but-unchanged field from the original input", () => {
    const policy = patchInverse({
      actionId: "delivery.setDownloadPolicy",
      idField: "productId",
      carryFromInput: ["downloadLimit", "downloadExpiryDays"],
    });

    const result = policy(
      recorded({
        input: { productId: 4, downloadLimit: 5, downloadExpiryDays: 30 },
        diff: [
          { entity: "product", entityId: "4", path: "downloadLimit", before: 3, after: 5 },
        ],
      }),
    );

    // The expiry did not change, so its current value is the one that was sent.
    expect(result?.input).toEqual({ productId: 4, downloadLimit: 3, downloadExpiryDays: 30 });
  });

  it("does not let a carried field overwrite a recorded one", () => {
    const policy = patchInverse({
      actionId: "delivery.setDownloadPolicy",
      idField: "productId",
      carryFromInput: ["downloadLimit"],
    });

    const result = policy(
      recorded({
        input: { productId: 4, downloadLimit: 5 },
        diff: [{ entity: "product", entityId: "4", path: "downloadLimit", before: 3, after: 5 }],
      }),
    );

    expect((result?.input as Record<string, unknown>).downloadLimit).toBe(3);
  });
});

describe("the registry's undoable flag", () => {
  it("is never a bare claim — every undoable action defines an inverse", () => {
    // `defineAction` throws on a mismatch, so importing the registry is most of
    // this test. The assertion is what makes the failure legible.
    for (const def of allActions()) {
      expect(def.undoable === true).toBe(typeof def.inverse === "function");
    }
  });

  it("holds the four actions that turned out not to be invertible at false", () => {
    // Each lost the claim for its own reason — see the comment on each
    // definition. They are pinned here so a later edit has to argue with a test
    // rather than flip a boolean.
    for (const id of [
      "customers.update",
      "memberships.revoke",
      "readiness.updateIssues",
      "catalog.setProductOptions",
    ]) {
      expect(getAction(id)?.undoable ?? false).toBe(false);
    }
  });
});

describe("action-specific inverses", () => {
  it("inverts a stock adjustment by appending the opposite entry", () => {
    const result = getAction("inventory.adjust")?.inverse?.(
      recorded({
        input: { variantId: 2, locationId: 1, delta: -5, reason: "damaged" },
      }),
    );

    expect(result?.input).toEqual({
      variantId: 2,
      locationId: 1,
      delta: 5,
      reason: "Undo: damaged",
    });
    // The level is a sum over a ledger, so intervening sales do not make the
    // opposite entry wrong — checking would refuse exactly when undo is needed.
    expect(result?.conflictCheck).toBe("none");
  });

  it("refuses to undo a membership grant that only extended an existing one", () => {
    const grant = getAction("memberships.grant");
    const extension = recorded({
      input: { customerId: 1, tierId: 2, durationDays: 30 },
      diff: [
        {
          entity: "customer_membership",
          entityId: "9",
          path: "endsAt",
          before: "2026-09-01T00:00:00.000Z",
          after: "2026-10-01T00:00:00.000Z",
        },
      ],
    });

    // Revoking would end access the merchant never asked to end.
    expect(grant?.inverse?.(extension)).toBeNull();
  });

  it("undoes a membership grant that created one, by revoking it", () => {
    const grant = getAction("memberships.grant");
    const created = recorded({
      input: { customerId: 1, tierId: 2, durationDays: 30 },
      diff: [
        {
          entity: "customer_membership",
          entityId: "9",
          path: "granted",
          before: null,
          after: "gold",
        },
        {
          entity: "customer_membership",
          entityId: "9",
          path: "endsAt",
          before: null,
          after: "2026-10-01T00:00:00.000Z",
        },
      ],
    });

    expect(grant?.inverse?.(created)).toMatchObject({
      actionId: "memberships.revoke",
      input: { customerId: 1, tierId: 2 },
    });
  });

  it("refuses to undo a domain connection that replaced another domain", () => {
    const connect = getAction("domains.connect");
    const replacement = recorded({
      input: { siteId: 3, domain: "new.example" },
      diff: [
        {
          entity: "site",
          entityId: "3",
          path: "customDomain",
          before: "old.example",
          after: "new.example",
        },
      ],
    });

    // Re-connecting would return it as `pending`, and only a verified domain
    // resolves — the undo would take a live storefront offline.
    expect(connect?.inverse?.(replacement)).toBeNull();
  });

  it("undoes a first domain connection by disconnecting", () => {
    const connect = getAction("domains.connect");
    const first = recorded({
      input: { siteId: 3, domain: "new.example" },
      diff: [
        {
          entity: "site",
          entityId: "3",
          path: "customDomain",
          before: null,
          after: "new.example",
        },
      ],
    });

    expect(connect?.inverse?.(first)).toMatchObject({
      actionId: "domains.disconnect",
      input: { siteId: 3 },
    });
  });

  it("lifts a download revocation without handing back a fresh download count", () => {
    const result = getAction("delivery.revokeDownload")?.inverse?.(
      recorded({ input: { grantId: 12, reason: "chargeback" } }),
    );

    expect(result).toMatchObject({
      actionId: "delivery.reissueDownload",
      input: { grantId: 12, resetCount: false, unrevoke: true },
    });
  });

  it("does not re-suppress an address that was never actually lifted", () => {
    const unsuppress = getAction("email.unsuppressAddress");
    const refused = recorded({ result: { email: "a@example.com", removed: false } });
    expect(unsuppress?.inverse?.(refused)).toBeNull();
  });

  it("restores a collection's previous membership and its order", () => {
    const result = getAction("catalog.setCollectionProducts")?.inverse?.(
      recorded({
        diff: [
          {
            entity: "collection",
            entityId: "5",
            path: "products",
            before: [9, 3, 7],
            after: [3, 9],
          },
        ],
      }),
    );

    // Order is the merchandising, so the inverse has to restore the sequence,
    // not just the set. This diff recorded `before: null` until undo was built.
    expect(result?.input).toEqual({ collectionId: 5, productIds: [9, 3, 7] });
  });

  it("empties a collection whose previous membership was empty", () => {
    const result = getAction("catalog.setCollectionProducts")?.inverse?.(
      recorded({
        diff: [
          { entity: "collection", entityId: "5", path: "products", before: [], after: [3] },
        ],
      }),
    );
    expect(result?.input).toEqual({ collectionId: 5, productIds: [] });
  });

  it("restores tax settings that had no row to the defaults a missing row produced", () => {
    const result = getAction("tax.updateSettings")?.inverse?.(
      recorded({
        input: { siteId: 2, provider: "stripe" },
        diff: [
          {
            entity: "taxSettings",
            entityId: "2",
            path: "provider",
            before: null,
            after: "stripe",
          },
        ],
      }),
    );

    // `provider: null` is not a value the schema accepts; "none" is what an
    // absent row behaved as.
    expect(result?.input).toEqual({ siteId: 2, provider: "none" });
  });

  it("restores a variant's previous price against the real definition", () => {
    const result = getAction("catalog.updateVariant")?.inverse?.(
      recorded({
        input: { variantId: 7, priceMinor: 1200 },
        diff: [entry("priceMinor", 1500, 1200)],
      }),
    );
    expect(result?.input).toEqual({ variantId: 7, priceMinor: 1500 });
  });

  it("restores a subscription cancellation flag to what it was", () => {
    const result = getAction("billing.setCancellation")?.inverse?.(
      recorded({
        input: { cancelAtPeriodEnd: true },
        diff: [
          {
            entity: "organization",
            entityId: "org_1",
            path: "cancelAtPeriodEnd",
            before: false,
            after: true,
          },
        ],
      }),
    );

    expect(result?.input).toEqual({ cancelAtPeriodEnd: false });
  });
});
