/* Seed demo data: 3 sites, categories, ~30 products, orders, agent traffic.
   Run with: pnpm db:seed (after pnpm db:push) */
import { eq } from "drizzle-orm";
import { agentTraffic, categories, db, integrations, orders, products, sites } from "../lib/db";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — create .env.local (see .env.example) first.");
  process.exit(1);
}

// deterministic pseudo-random so reseeding is stable
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const daysAgo = (n: number) =>
  new Date(Date.now() - n * 24 * 3600 * 1000 + Math.floor(rand() * 20 * 3600 * 1000));

const DEMO_WALLET = "0x1a6f8be821d047fcf4dc1bd5c66aa00000000001";

const img = (s: string) => [`https://picsum.photos/seed/${s}/800/600`];

async function main() {
  console.log("Clearing existing data…");
  await db.delete(agentTraffic);
  await db.delete(orders);
  await db.delete(products);
  await db.delete(categories);
  await db.delete(sites);
  await db.delete(integrations);

  console.log("Creating integrations…");
  await db.insert(integrations).values({
    provider: "x402",
    status: "connected",
    config: { walletAddress: DEMO_WALLET },
  });

  console.log("Creating sites…");
  const [aurora, pixel, brew] = await db
    .insert(sites)
    .values([
      {
        name: "Aurora Supply Co.",
        slug: "aurora-supply",
        status: "live",
        walletAddress: DEMO_WALLET,
      },
      { name: "Pixel Threads", slug: "pixel-threads", status: "live", walletAddress: DEMO_WALLET },
      { name: "Brew Haus", slug: "brew-haus", status: "draft" },
    ])
    .returning();

  console.log("Creating categories…");
  const [deskGear, edc, notebooks, tees, hoodies, beans, gear] = await db
    .insert(categories)
    .values([
      { siteId: aurora.id, name: "Desk Gear", slug: "desk-gear" },
      { siteId: aurora.id, name: "Everyday Carry", slug: "everyday-carry" },
      { siteId: aurora.id, name: "Notebooks", slug: "notebooks" },
      { siteId: pixel.id, name: "T-Shirts", slug: "t-shirts" },
      { siteId: pixel.id, name: "Hoodies", slug: "hoodies" },
      { siteId: brew.id, name: "Coffee Beans", slug: "coffee-beans" },
      { siteId: brew.id, name: "Brewing Gear", slug: "brewing-gear" },
    ])
    .returning();
  // make Notebooks a subcategory of Desk Gear
  await db.update(categories).set({ parentId: deskGear.id }).where(eq(categories.id, notebooks.id));

  console.log("Creating products…");
  const catalog: [number, number | null, string, number][] = [
    [aurora.id, notebooks.id, "Aurora Field Notebook", 1400],
    [aurora.id, notebooks.id, "Dot-Grid Journal A5", 1900],
    [aurora.id, deskGear.id, "Brass Desk Pen", 3800],
    [aurora.id, deskGear.id, "Desk Mat — Slate", 4900],
    [aurora.id, deskGear.id, "Walnut Monitor Stand", 8900],
    [aurora.id, deskGear.id, "Cable Organizer Kit", 1600],
    [aurora.id, edc.id, "Titanium Key Clip", 2200],
    [aurora.id, edc.id, "Waxed Canvas Pouch", 3200],
    [aurora.id, edc.id, "Mini Flashlight 500lm", 2800],
    [aurora.id, edc.id, "Leather Card Wallet", 3500],
    [pixel.id, tees.id, "Glitch Logo Tee", 2400],
    [pixel.id, tees.id, "8-Bit Sunset Tee", 2400],
    [pixel.id, tees.id, "Terminal Green Tee", 2600],
    [pixel.id, tees.id, "ASCII Cat Tee", 2500],
    [pixel.id, tees.id, "Retro Wave Tee", 2400],
    [pixel.id, hoodies.id, "Midnight Compile Hoodie", 5400],
    [pixel.id, hoodies.id, "Pixel Fade Hoodie", 5800],
    [pixel.id, hoodies.id, "Debug Mode Hoodie", 5600],
    [pixel.id, null, "Sticker Pack Vol. 1", 800],
    [pixel.id, null, "Enamel Pin — Bug", 1200],
    [brew.id, beans.id, "Ethiopia Yirgacheffe 250g", 1800],
    [brew.id, beans.id, "Colombia Huila 250g", 1650],
    [brew.id, beans.id, "Espresso Blend No. 4", 1700],
    [brew.id, beans.id, "Decaf Sumatra 250g", 1750],
    [brew.id, gear.id, "Ceramic Pour-Over Dripper", 3400],
    [brew.id, gear.id, "Gooseneck Kettle 1L", 6900],
    [brew.id, gear.id, "Hand Grinder Steel Burr", 7800],
    [brew.id, gear.id, "Digital Brew Scale", 4200],
    [brew.id, gear.id, "Double-Wall Glass Mug", 2100],
    [brew.id, null, "Gift Card $25", 2500],
  ];
  const slugify = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
  const createdProducts = await db
    .insert(products)
    .values(
      catalog.map(([siteId, categoryId, name, priceCents], i) => ({
        siteId,
        categoryId,
        name,
        slug: slugify(name),
        description: `${name} — demo product from the Markii seed catalog.`,
        priceCents,
        sku: `SEED-${String(i + 1).padStart(3, "0")}`,
        stock: 10 + Math.floor(rand() * 90),
        images: img(slugify(name)),
      })),
    )
    .returning();

  // suggested products within Aurora
  const auroraProducts = createdProducts.filter((p) => p.siteId === aurora.id);
  await db
    .update(products)
    .set({ suggestedProductIds: [auroraProducts[1].id, auroraProducts[2].id] })
    .where(eq(products.id, auroraProducts[0].id));

  console.log("Creating orders…");
  const agents = [
    { ua: "Claude-Agent/1.0 (Anthropic)", name: "Claude" },
    { ua: "GPTBot/1.1 (+https://openai.com/gptbot)", name: "GPTBot" },
    { ua: "PerplexityBot/1.0", name: "PerplexityBot" },
    { ua: "Gemini-Agent/2.0 (Google)", name: "Gemini" },
  ];
  const statuses = ["success", "success", "success", "success", "pending", "cancel", "failed"] as const;
  const orderValues = Array.from({ length: 24 }, (_, i) => {
    const product = pick(createdProducts.filter((p) => p.siteId !== brew.id));
    const agent = pick(agents);
    const status = statuses[i % statuses.length];
    const quantity = 1 + Math.floor(rand() * 2);
    return {
      siteId: product.siteId,
      productId: product.id,
      quantity,
      status,
      amountCents: product.priceCents * quantity,
      currency: "USDC",
      provider: "x402" as const,
      txHash:
        status === "success"
          ? `0x${Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("")}`
          : null,
      agentUserAgent: agent.ua,
      agentName: agent.name,
      agentWalletAddress: `0x${Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("")}`,
      createdAt: daysAgo(Math.floor(rand() * 14)),
    };
  });
  await db.insert(orders).values(orderValues);

  console.log("Creating agent traffic…");
  const paths = ["/", "/llms.txt", "/agent.md"];
  const liveSites = [aurora, pixel];
  const trafficValues = Array.from({ length: 500 }, () => {
    const site = pick(liveSites);
    const agent = pick([...agents, { ua: "Mozilla/5.0 (compatible)", name: "Other" }]);
    const siteProducts = createdProducts.filter((p) => p.siteId === site.id);
    const product = rand() < 0.55 ? pick(siteProducts) : null;
    return {
      siteId: site.id,
      productId: product?.id ?? null,
      path: product ? `/p/${product.slug}` : pick(paths),
      agentUserAgent: agent.ua,
      agentName: agent.name,
      createdAt: daysAgo(Math.floor(rand() * 14)),
    };
  });
  await db.insert(agentTraffic).values(trafficValues);

  console.log(
    `Done: 3 sites, 7 categories, ${createdProducts.length} products, ${orderValues.length} orders, ${trafficValues.length} traffic events.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
