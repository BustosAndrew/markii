import { describe, expect, it } from "vitest";
import { productCreateSchema, productUpdateSchema } from "./validation";

describe("productCreateSchema membership and delivery fields", () => {
  it("accepts membership-related product fields on create", () => {
    const parsed = productCreateSchema.parse({
      siteId: 1,
      name: "Members club",
      priceCents: 2_500,
      requiresTierId: 3,
      grantsTierId: 4,
      grantsDurationDays: 365,
      grantsRenewalInterval: "year",
    });

    expect(parsed.requiresTierId).toBe(3);
    expect(parsed.grantsTierId).toBe(4);
    expect(parsed.grantsDurationDays).toBe(365);
    expect(parsed.grantsRenewalInterval).toBe("year");
  });

  it("carries the same fields through the partial update schema", () => {
    const parsed = productUpdateSchema.parse({
      requiresTierId: null,
      grantsTierId: 7,
      grantsDurationDays: 30,
      grantsRenewalInterval: "month",
    });

    expect(parsed).toEqual({
      requiresTierId: null,
      grantsTierId: 7,
      grantsDurationDays: 30,
      grantsRenewalInterval: "month",
    });
  });

  it("refuses an excessive grant duration", () => {
    const result = productCreateSchema.safeParse({
      siteId: 1,
      name: "Too long",
      priceCents: 1_000,
      grantsDurationDays: 3651,
    });

    expect(result.success).toBe(false);
  });
});
