import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../../api";
import { customerAddresses, customers, sites } from "../../db";
import { ownSites, siteScope } from "../../tenancy";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Customer actions (§18.3).
 *
 * **PII discipline is part of the contract**, not an afterthought: these records
 * are never logged, never fed to a model as instruction, and marketing consent
 * is explicit and timestamped. `redactInput` keeps names, emails, and phone
 * numbers out of the audit table, which is long-lived and widely readable.
 */

async function ownedCustomer(ctx: ActionContext, id: number) {
  if (!ctx.actor.orgId) throw notFound("Customer");
  const [row] = await ctx.db
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), siteScope(ctx.actor.orgId, customers.siteId)))
    .limit(1);
  if (!row) throw notFound("Customer");
  return row;
}

/** Audit rows outlive the record they describe — keep PII out of them. */
function redactCustomerPii(input: Record<string, unknown>) {
  const redacted = { ...input };
  for (const key of ["email", "firstName", "lastName", "phone", "note"]) {
    if (redacted[key] != null) redacted[key] = "[redacted]";
  }
  return redacted;
}

export const createCustomer = defineAction({
  id: "customers.create",
  description:
    "Create a customer record on a store. Marketing consent is never assumed — pass " +
    "acceptsMarketing explicitly, and it is timestamped when true.",
  input: z.object({
    siteId: z.number().int().positive(),
    email: z.email().max(255),
    firstName: z.string().max(120).nullish(),
    lastName: z.string().max(120).nullish(),
    phone: z.string().max(40).nullish(),
    acceptsMarketing: z.boolean().default(false),
    tags: z.array(z.string().min(1).max(60)).max(50).default([]),
    note: z.string().max(5000).nullish(),
  }),
  permission: "commerce.write",
  riskTier: "low",
  undoable: false,
  redactInput: redactCustomerPii,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Site");
    const [site] = await ctx.db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, input.siteId), ownSites(ctx.actor.orgId)))
      .limit(1);
    if (!site) throw notFound("Site");

    const email = input.email.toLowerCase();
    const [taken] = await ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.siteId, input.siteId), eq(customers.email, email)))
      .limit(1);
    if (taken) throw conflict("A customer with that email already exists on this store");

    const [row] = await ctx.db
      .insert(customers)
      .values({
        siteId: input.siteId,
        email,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        phone: input.phone ?? null,
        acceptsMarketing: input.acceptsMarketing,
        // Timestamped only when consent is actually given.
        marketingConsentAt: input.acceptsMarketing ? new Date() : null,
        tags: input.tags,
        note: input.note ?? null,
      })
      .returning();

    // The diff records that a customer was created, not who they are.
    ctx.recordDiff({
      entity: "customer",
      entityId: String(row.id),
      path: "created",
      before: null,
      after: true,
    });
    return { id: row.id, siteId: row.siteId };
  },
});

export const updateCustomer = defineAction({
  id: "customers.update",
  description:
    "Update a customer's details, tags, note, or marketing consent. Withdrawing consent clears " +
    "its timestamp; granting it sets a fresh one.",
  input: z.object({
    customerId: z.number().int().positive(),
    email: z.email().max(255).optional(),
    firstName: z.string().max(120).nullish(),
    lastName: z.string().max(120).nullish(),
    phone: z.string().max(40).nullish(),
    acceptsMarketing: z.boolean().optional(),
    tags: z.array(z.string().min(1).max(60)).max(50).optional(),
    note: z.string().max(5000).nullish(),
  }),
  permission: "commerce.write",
  riskTier: "low",
  undoable: true,
  redactInput: redactCustomerPii,
  async run(input, ctx) {
    const { customerId, ...patch } = input;
    const existing = await ownedCustomer(ctx, customerId);

    const changes: Record<string, unknown> = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    );
    if (typeof changes.email === "string") changes.email = changes.email.toLowerCase();

    if (patch.acceptsMarketing !== undefined) {
      /**
       * Consent is re-timestamped on grant and cleared on withdrawal. Keeping a
       * stale timestamp on a withdrawn consent would misrepresent the record if
       * it is ever produced as evidence.
       */
      changes.marketingConsentAt = patch.acceptsMarketing
        ? (existing.acceptsMarketing ? existing.marketingConsentAt : new Date())
        : null;
    }

    if (Object.keys(changes).length === 0) throw badRequest("No changes supplied");

    // Field names only — the values are the PII.
    for (const key of Object.keys(changes)) {
      ctx.recordDiff({
        entity: "customer",
        entityId: String(customerId),
        path: key,
        before: "[redacted]",
        after: "[redacted]",
      });
    }

    const [row] = await ctx.db
      .update(customers)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(customers.id, customerId))
      .returning();
    return { id: row.id, acceptsMarketing: row.acceptsMarketing };
  },
});

export const addCustomerAddress = defineAction({
  id: "customers.addAddress",
  description: "Add an address to a customer. Setting it default demotes any previous default.",
  input: z.object({
    customerId: z.number().int().positive(),
    name: z.string().max(120).nullish(),
    line1: z.string().min(1).max(200),
    line2: z.string().max(200).nullish(),
    city: z.string().min(1).max(120),
    province: z.string().max(120).nullish(),
    postalCode: z.string().max(40).nullish(),
    country: z.string().length(2).regex(/^[A-Za-z]{2}$/),
    phone: z.string().max(40).nullish(),
    isDefault: z.boolean().default(false),
  }),
  permission: "commerce.write",
  riskTier: "low",
  undoable: false,
  redactInput: (input) => ({ customerId: input.customerId, address: "[redacted]" }),
  async run(input, ctx) {
    const customer = await ownedCustomer(ctx, input.customerId);

    if (input.isDefault) {
      await ctx.db
        .update(customerAddresses)
        .set({ isDefault: false })
        .where(eq(customerAddresses.customerId, customer.id));
    }

    const [row] = await ctx.db
      .insert(customerAddresses)
      .values({
        customerId: customer.id,
        name: input.name ?? null,
        line1: input.line1,
        line2: input.line2 ?? null,
        city: input.city,
        province: input.province ?? null,
        postalCode: input.postalCode ?? null,
        country: input.country.toUpperCase(),
        phone: input.phone ?? null,
        isDefault: input.isDefault,
      })
      .returning();

    ctx.recordDiff({
      entity: "customerAddress",
      entityId: String(row.id),
      path: "created",
      before: null,
      after: true,
    });
    return { id: row.id, customerId: customer.id, isDefault: row.isDefault };
  },
});

export const deleteCustomer = defineAction({
  id: "customers.delete",
  description:
    "Erase a customer record and their addresses — the deletion half of the §18.3 PII duty. " +
    "Their orders are kept with the customer link nulled: erasing a person must not destroy the " +
    "merchant's financial and tax records.",
  input: z.object({ customerId: z.number().int().positive() }),
  permission: "commerce.write",
  /** Irreversible and privacy-affecting: a human should see it before it runs. */
  riskTier: "high",
  undoable: false,
  async run(input, ctx) {
    const customer = await ownedCustomer(ctx, input.customerId);
    // `orders.customerId` is ON DELETE SET NULL, so order history survives.
    await ctx.db.delete(customers).where(eq(customers.id, customer.id));

    ctx.recordDiff({
      entity: "customer",
      entityId: String(customer.id),
      path: "erased",
      before: true,
      after: null,
    });
    return { deleted: true, id: customer.id };
  },
});
