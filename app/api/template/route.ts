import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";

/**
 * Placeholder data for the wizard's "autofill from template" button.
 * Shape matches the POST /api/preview request body exactly.
 */
export const GET = orgHandler(async () => {
  return NextResponse.json({
    site: {
      name: "Aurora Supply Co.",
      slug: "aurora-supply",
      description:
        "Everyday carry and desk gear, built to last. Agent-friendly checkout via x402.",
      indexed: true,
    },
    categories: [
      { name: "Desk Gear", slug: "desk-gear" },
      { name: "Everyday Carry", slug: "everyday-carry" },
      { name: "Notebooks", slug: "notebooks", parentSlug: "desk-gear" },
    ],
    products: [
      {
        name: "Aurora Field Notebook",
        slug: "aurora-field-notebook",
        priceCents: 1400,
        currency: "USD",
        description: "48-page dot-grid notebook with a waterproof cover.",
        categorySlug: "notebooks",
        sku: "AUR-NB-01",
        stock: 120,
        images: ["https://picsum.photos/seed/aurora-notebook/800/600"],
      },
      {
        name: "Brass Desk Pen",
        slug: "brass-desk-pen",
        priceCents: 3800,
        currency: "USD",
        description: "Machined brass pen with a weighted base stand.",
        categorySlug: "desk-gear",
        sku: "AUR-PEN-02",
        stock: 45,
        images: ["https://picsum.photos/seed/aurora-pen/800/600"],
      },
      {
        name: "Titanium Key Clip",
        slug: "titanium-key-clip",
        priceCents: 2200,
        currency: "USD",
        description: "Featherweight titanium carabiner for keys and tools.",
        categorySlug: "everyday-carry",
        sku: "AUR-CLIP-03",
        stock: 80,
        images: ["https://picsum.photos/seed/aurora-clip/800/600"],
      },
      {
        name: "Waxed Canvas Pouch",
        slug: "waxed-canvas-pouch",
        priceCents: 3200,
        currency: "USD",
        description: "Water-resistant zip pouch for cables and small tools.",
        categorySlug: "everyday-carry",
        sku: "AUR-PCH-04",
        stock: 60,
        images: ["https://picsum.photos/seed/aurora-pouch/800/600"],
      },
      {
        name: "Desk Mat — Slate",
        slug: "desk-mat-slate",
        priceCents: 4900,
        currency: "USD",
        description: "90×40 cm vegan-leather desk mat in slate grey.",
        categorySlug: "desk-gear",
        sku: "AUR-MAT-05",
        stock: 30,
        images: ["https://picsum.photos/seed/aurora-mat/800/600"],
      },
    ],
  });
});
