import { buildNode, validateTree, randomNodeId, type IdGenerator, type NodeInput } from "./tree";
import type { PageNode } from "./types";

/**
 * Presets: ready-made subtrees of ordinary blocks (`docs/BUILDER.md` §5).
 *
 * A hero is a section with a heading, text and a button — not a block type of
 * its own — so once inserted every part of it is editable like anything else,
 * and the renderer never grows a special case.
 */
export const PRESETS: Record<string, { label: string; description: string; node: NodeInput }> = {
  hero: {
    label: "Hero",
    description: "The page's opening: a main heading, a line of copy and a call to action.",
    node: {
      type: "section",
      intent: "hero",
      styles: { base: { paddingY: "3xl", paddingX: "md", width: "content", align: "center" } },
      children: [
        { type: "heading", props: { text: "Your headline", level: 1 } },
        { type: "text", props: { markdown: "One sentence on what the store is for." } },
        { type: "button", props: { label: "Shop now", href: "/collections", variant: "primary" } },
      ],
    },
  },
  imageWithText: {
    label: "Image with text",
    description: "An image beside a heading, copy and a button; stacks on phones.",
    node: {
      type: "section",
      intent: "image with text",
      children: [
        {
          type: "columns",
          children: [
            { type: "column", children: [{ type: "image" }] },
            {
              type: "column",
              children: [
                { type: "heading", props: { text: "A heading", level: 2 } },
                { type: "text", props: { markdown: "A few sentences." } },
                { type: "button", props: { label: "Learn more", href: "/collections", variant: "secondary" } },
              ],
            },
          ],
        },
      ],
    },
  },
  featureRow: {
    label: "Feature row",
    description: "Three short points side by side.",
    node: {
      type: "section",
      intent: "features",
      children: [
        {
          type: "grid",
          children: [1, 2, 3].map((n) => ({
            type: "text",
            props: { markdown: `**Point ${n}**\nA sentence about it.` },
          })),
        },
      ],
    },
  },
  faqSection: {
    label: "FAQ section",
    description: "A heading and a list of questions, published as FAQPage structured data.",
    node: {
      type: "section",
      intent: "faq",
      children: [
        { type: "heading", props: { text: "Questions", level: 2 } },
        { type: "faq" },
      ],
    },
  },
  productShowcase: {
    label: "Product showcase",
    description: "A heading over a grid of products.",
    node: {
      type: "section",
      intent: "products",
      children: [
        { type: "heading", props: { text: "Shop", level: 2 } },
        { type: "productGrid", props: { source: "all", limit: 8 } },
      ],
    },
  },
  productCards: {
    label: "Custom product cards",
    description:
      "A heading over a repeater of the store's products, each drawn from blocks you can restyle — image, name, price.",
    node: {
      type: "section",
      intent: "products",
      children: [
        { type: "heading", props: { text: "Shop", level: 2 } },
        { type: "repeater", props: { source: "store.products", limit: 8, minItemWidth: "sm" }, children: relatedCard() },
      ],
    },
  },
};

/**
 * The tree a site's home starts as when its design is first opened: the same
 * hero and product grid the fixed storefront has always rendered
 * (`app/%5Fsites/[site]/page.tsx`), so opening the builder changes nothing a
 * shopper sees until the merchant edits something (`docs/BUILDER.md` §14).
 */
export function defaultHomeTree(
  site: { name: string; agentDiscovery: boolean },
  id: IdGenerator = randomNodeId,
): PageNode {
  const taken = new Set<string>();
  const root: PageNode = { id: id(), type: "root", props: {}, children: [] };
  taken.add(root.id);
  root.children = [
    buildNode(
      {
        type: "section",
        intent: "store intro",
        styles: { base: { paddingY: "xl", paddingX: "md", width: "content" } },
        children: [
          { type: "heading", props: { text: site.name.slice(0, 200), level: 1 } },
          {
            type: "text",
            props: {
              markdown: site.agentDiscovery
                ? "Agent-readable store — see [llms.txt](/llms.txt) and [agent.md](/agent.md)."
                : `Welcome to ${site.name}.`,
            },
          },
        ],
      },
      taken,
      id,
    ),
    buildNode(
      {
        type: "section",
        intent: "all products",
        styles: { base: { paddingX: "md", paddingY: "md", width: "content" } },
        children: [{ type: "productGrid", props: { source: "all", limit: 48 } }],
      },
      taken,
      id,
    ),
  ];
  return validateTree(root);
}

function treeOf(children: NodeInput[], id: IdGenerator): PageNode {
  const taken = new Set<string>();
  const root: PageNode = { id: id(), type: "root", props: {}, children: [] };
  taken.add(root.id);
  root.children = children.map((c) => buildNode(c, taken, id));
  return validateTree(root);
}

/**
 * The product template a store starts from (M4) — the fixed product page
 * (`app/%5Fsites/[site]/p/[productSlug]/page.tsx`) as blocks: images beside
 * the name, price, stock, description and Buy, then related products. The
 * props are design-time placeholders; the bindings fill them per product.
 */
export function defaultProductTemplate(id: IdGenerator = randomNodeId): PageNode {
  return treeOf(
    [
      {
        type: "section",
        intent: "product",
        styles: { base: { paddingY: "lg", paddingX: "md", width: "content" } },
        children: [
          {
            type: "columns",
            children: [
              { type: "column", children: [{ type: "productGallery" }] },
              {
                type: "column",
                children: [
                  { type: "heading", props: { text: "Product name", level: 1 }, bindings: { text: "product.title" } },
                  {
                    type: "text",
                    props: { markdown: "Price" },
                    bindings: { markdown: "product.price" },
                    styles: { base: { fontSize: "lg", marginBottom: "0" } },
                  },
                  {
                    type: "text",
                    props: { markdown: "In stock" },
                    bindings: { markdown: "product.stockStatus" },
                    styles: { base: { color: "muted", fontSize: "sm" } },
                  },
                  {
                    type: "text",
                    props: { markdown: "The product's description." },
                    bindings: { markdown: "product.description" },
                    visibleWhen: { path: "product.description", op: "exists" },
                  },
                  { type: "productBuy" },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "section",
        intent: "related products",
        visibleWhen: { path: "product.relatedCount", op: "gt", value: 0 },
        styles: { base: { paddingY: "lg", paddingX: "md", width: "content" } },
        children: [
          { type: "heading", props: { text: "You might also like", level: 2 } },
          {
            type: "repeater",
            props: { source: "product.related", limit: 8, minItemWidth: "sm" },
            children: relatedCard(),
          },
        ],
      },
    ],
    id,
  );
}

/** One product in a repeater: its image linking to it, its name, its price. */
function relatedCard(): NodeInput[] {
  return [
    {
      type: "image",
      props: { aspect: "1/1" },
      bindings: { src: "item.image", alt: "item.title", href: "item.url" },
    },
    { type: "heading", props: { text: "Product name", level: 3 }, bindings: { text: "item.title" }, styles: { base: { fontSize: "md" } } },
    { type: "text", props: { markdown: "Price" }, bindings: { markdown: "item.price" }, styles: { base: { color: "muted" } } },
  ];
}

/** The collection template (M4): the fixed collection page as blocks. */
export function defaultCollectionTemplate(id: IdGenerator = randomNodeId): PageNode {
  return treeOf(
    [
      {
        type: "section",
        intent: "collection intro",
        styles: { base: { paddingY: "xl", paddingX: "md", width: "content" } },
        children: [
          { type: "heading", props: { text: "Collection title", level: 1 }, bindings: { text: "collection.title" } },
          {
            type: "text",
            props: { markdown: "The collection's description." },
            bindings: { markdown: "collection.description" },
            visibleWhen: { path: "collection.description", op: "exists" },
          },
          {
            type: "text",
            props: { markdown: "Nothing in this collection right now." },
            visibleWhen: { path: "collection.productCount", op: "eq", value: 0 },
          },
        ],
      },
      {
        type: "section",
        intent: "collection products",
        props: { label: "Products" },
        styles: { base: { paddingY: "md", paddingX: "md", width: "content" } },
        children: [{ type: "productGrid", props: { source: "current", limit: 48 } }],
      },
    ],
    id,
  );
}

/**
 * The header region (M4): the fixed header's three parts — the store's name,
 * the category menu, and search, account and cart. Rendered inside the
 * theme's own header frame, so each theme keeps its look.
 */
export function defaultHeaderRegion(id: IdGenerator = randomNodeId): PageNode {
  return treeOf(
    [
      { type: "storeBrand" },
      { type: "navMenu", props: { label: "Categories", categories: true, collections: true } },
      { type: "storeLinks" },
    ],
    id,
  );
}

/** The footer region (M4). The fixed storefront has none, so this is new to shoppers once published. */
export function defaultFooterRegion(id: IdGenerator = randomNodeId): PageNode {
  return treeOf(
    [
      {
        type: "section",
        intent: "footer",
        styles: { base: { paddingY: "lg", paddingX: "md", width: "content" } },
        children: [
          {
            type: "row",
            children: [
              { type: "text", props: { markdown: "© Your store" }, bindings: { markdown: "store.copyright" }, styles: { base: { color: "muted", fontSize: "sm" } } },
              { type: "navMenu", props: { label: "Footer", items: [{ label: "Search", href: "/search" }], collections: true } },
            ],
          },
        ],
      },
    ],
    id,
  );
}

/** The announcement bar (M4): one line across the top of every page. Starts as a placeholder to replace. */
export function defaultAnnouncementRegion(id: IdGenerator = randomNodeId): PageNode {
  return treeOf(
    [
      {
        type: "section",
        intent: "announcement",
        styles: { base: { background: "accent", paddingY: "xs", paddingX: "md", align: "center", fontSize: "sm" } },
        children: [{ type: "text" }],
      },
    ],
    id,
  );
}

export const DEFAULT_TEMPLATE_TREES = {
  product: defaultProductTemplate,
  collection: defaultCollectionTemplate,
} as const;

export const DEFAULT_REGION_TREES = {
  header: defaultHeaderRegion,
  footer: defaultFooterRegion,
  announcement: defaultAnnouncementRegion,
} as const;

/** A blank new page: one section with its title as the heading. */
export function blankPageTree(title: string, id: IdGenerator = randomNodeId): PageNode {
  const taken = new Set<string>();
  const root: PageNode = { id: id(), type: "root", props: {}, children: [] };
  taken.add(root.id);
  root.children = [
    buildNode(
      { type: "section", children: [{ type: "heading", props: { text: title.slice(0, 200), level: 1 } }] },
      taken,
      id,
    ),
  ];
  return validateTree(root);
}
