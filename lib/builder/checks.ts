import { getBlock } from "./blocks";
import { contrastWarnings } from "./tokens";
import type { ThemeTokens } from "@/lib/storefront/themes";
import type { PageNode } from "./types";

/**
 * Pre-publish checks (`docs/BUILDER.md` §12): **errors block publishing,
 * warnings inform.** An error is something that would ship broken — an image
 * with no source, a featured product that does not exist. A warning is
 * something a person should look at — a skipped heading level, missing alt
 * text, low contrast — and may have a reason for.
 *
 * Pure: the caller passes what the catalogue holds, so these run the same in
 * the editor, for the agent, and at publish.
 */

export type CheckResult = {
  severity: "error" | "warning";
  code: string;
  message: string;
  pageHandle?: string;
  nodeId?: string;
};

export type CatalogFacts = {
  productSlugs: Set<string>;
  categorySlugs: Set<string>;
  collectionHandles: Set<string>;
};

const PLACEHOLDER_TYPES = new Set(["heading", "text", "testimonial", "faq", "accordion", "list"]);

function walk(node: PageNode, fn: (n: PageNode, parent: PageNode | null) => void, parent: PageNode | null = null) {
  fn(node, parent);
  for (const child of node.children ?? []) walk(child, fn, node);
}

export function checkPage(tree: PageNode, catalog: CatalogFacts, pageHandle?: string): CheckResult[] {
  const out: CheckResult[] = [];
  const push = (severity: CheckResult["severity"], code: string, message: string, nodeId?: string) =>
    out.push({ severity, code, message, pageHandle, nodeId });

  const headings: { level: number; nodeId: string }[] = [];

  walk(tree, (node) => {
    const p = node.props as Record<string, unknown>;
    switch (node.type) {
      case "heading":
        headings.push({ level: Number(p.level ?? 2), nodeId: node.id });
        break;
      case "image":
        if (!p.src) push("error", "MISSING_IMAGE_SOURCE", "An image block has no image chosen.", node.id);
        else if (!p.decorative && !String(p.alt ?? "").trim()) {
          push("warning", "MISSING_ALT", "An image has no alt text. Describe it, or mark it decorative.", node.id);
        }
        break;
      case "video":
        if (!p.url) push("error", "MISSING_VIDEO_URL", "A video block has no YouTube or Vimeo link.", node.id);
        break;
      case "productCard":
        if (!p.productSlug) push("error", "PRODUCT_NOT_CHOSEN", "A featured-product block has no product chosen.", node.id);
        else if (!catalog.productSlugs.has(String(p.productSlug))) {
          push("error", "UNKNOWN_PRODUCT", `No enabled product "${p.productSlug}" in this store.`, node.id);
        }
        break;
      case "productGrid":
        if (p.source === "category" && !catalog.categorySlugs.has(String(p.categorySlug))) {
          push("error", "UNKNOWN_CATEGORY", `No category "${p.categorySlug}" in this store.`, node.id);
        }
        if (p.source === "collection" && !catalog.collectionHandles.has(String(p.collectionHandle))) {
          push("error", "UNKNOWN_COLLECTION", `No published collection "${p.collectionHandle}" in this store.`, node.id);
        }
        break;
      case "section": {
        const hasHeading = (node.children ?? []).some((c) => c.type === "heading");
        if ((node.children ?? []).length === 0) push("warning", "EMPTY_SECTION", "A section is empty.", node.id);
        else if (!hasHeading && !String(p.label ?? "").trim() && node.intent !== "hero") {
          push(
            "warning",
            "SECTION_UNLABELLED",
            "A section has no heading and no accessible label, so screen readers announce it without a name.",
            node.id,
          );
        }
        break;
      }
    }

    if (PLACEHOLDER_TYPES.has(node.type)) {
      const def = getBlock(node.type);
      if (def && JSON.stringify(def.defaults.props) === JSON.stringify(stripDefaults(p, def.defaults.props))) {
        push("warning", "PLACEHOLDER_TEXT", `A ${def.label.toLowerCase()} still has its placeholder text.`, node.id);
      }
    }
  });

  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length === 0) push("warning", "NO_H1", "The page has no level-1 heading.");
  if (h1s.length > 1) {
    for (const h of h1s.slice(1)) push("warning", "MULTIPLE_H1", "The page has more than one level-1 heading.", h.nodeId);
  }
  for (let i = 1; i < headings.length; i++) {
    if (headings[i].level > headings[i - 1].level + 1) {
      push(
        "warning",
        "HEADING_SKIP",
        `An h${headings[i - 1].level} is followed by an h${headings[i].level}; heading levels should not be skipped.`,
        headings[i].nodeId,
      );
    }
  }
  return out;
}

/** The props, reduced to the keys the defaults have, for a placeholder comparison. */
function stripDefaults(props: Record<string, unknown>, defaults: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(defaults).map((k) => [k, props[k]]));
}

export function checkTheme(theme: ThemeTokens): CheckResult[] {
  return contrastWarnings(theme).map((w) => ({ severity: "warning" as const, code: "LOW_CONTRAST", message: w.message }));
}

export function blockingErrors(results: CheckResult[]): CheckResult[] {
  return results.filter((r) => r.severity === "error");
}
