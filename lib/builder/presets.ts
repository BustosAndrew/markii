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
