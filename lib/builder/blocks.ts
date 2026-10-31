import { z } from "zod";
import { safeHref } from "./markdown";
import { SPACE_TOKENS, type NodeStyles } from "./types";

/**
 * The block registry ("stacks", `docs/BUILDER.md` §5).
 *
 * Every block type is registered once and declares everything the system
 * needs: its props schema (the single source of truth for validation), its
 * defaults, where it may sit, the inspector fields the editor generates, the
 * element it renders as, and descriptions **written for an agent as much as a
 * human**. The brand agent reads `description` and `usageHints` from here,
 * not from a separate prompt, so there is one place to update.
 *
 * **No React here.** Rendering lives in `./render`, so the dashboard, the
 * registry actions, the agent and the unit tests can import the registry
 * without pulling in server components. A test asserts every type has a
 * renderer.
 */

export type FieldSpec =
  | { name: string; label: string; kind: "text"; maxLength: number; placeholder?: string }
  | { name: string; label: string; kind: "markdown"; maxLength: number }
  | { name: string; label: string; kind: "number"; min: number; max: number }
  | { name: string; label: string; kind: "select"; options: { value: string | number; label: string }[] }
  | { name: string; label: string; kind: "boolean" }
  | { name: string; label: string; kind: "link" }
  | { name: string; label: string; kind: "image" }
  | { name: string; label: string; kind: "product" }
  | { name: string; label: string; kind: "category" }
  | { name: string; label: string; kind: "collection" }
  | { name: string; label: string; kind: "stringList"; maxItems: number; maxLength: number }
  | { name: string; label: string; kind: "items"; maxItems: number; fields: FieldSpec[] };

export type BlockCategory = "layout" | "content" | "commerce" | "media";

export type BlockDefinition = {
  type: string;
  label: string;
  category: BlockCategory;
  description: string;
  usageHints: string[];
  schema: z.ZodObject;
  defaults: { props: Record<string, unknown>; styles?: NodeStyles };
  /** What may be nested inside: `none`, `any` (minus `notInside` rules), or a list of types. */
  children: "none" | "any" | readonly string[];
  maxChildren?: number;
  /** Parents this block may sit in. Omitted: any parent that accepts it. */
  parents?: readonly string[];
  /** Hidden from the block library — `root` is the page itself, not something to add. */
  insertable: boolean;
  editorPanel: FieldSpec[];
  semantics: { element: string; landmark?: string };
  /** Reads the store's catalogue when it renders. */
  requiresData?: "catalog";
};

// ---------- shared field schemas ----------

const link = z
  .string()
  .max(2000)
  .refine((v) => safeHref(v) !== null, "Use a site path like /collections/new, an https:// URL, or mailto:.");

/** Images are https only: an http image on an https storefront is blocked by the browser. */
const imageUrl = z.string().max(2000).regex(/^https:\/\/\S+$/, "Use an https:// image URL.");

const VIDEO_HOSTS = /^https:\/\/(www\.)?(youtube\.com\/watch\?v=[\w-]{6,20}|youtu\.be\/[\w-]{6,20}|vimeo\.com\/\d{4,12})(\S*)$/;

const LEVELS = [1, 2, 3, 4, 5, 6] as const;

function block(def: BlockDefinition): BlockDefinition {
  return def;
}

// ---------- the registry ----------

const DEFINITIONS: BlockDefinition[] = [
  block({
    type: "root",
    label: "Page",
    category: "layout",
    description: "The page itself. Every page has exactly one, at the top of the tree.",
    usageHints: ["Add sections to the root; most other blocks belong inside a section."],
    schema: z.object({}).strict(),
    defaults: { props: {} },
    children: "any",
    insertable: false,
    editorPanel: [],
    semantics: { element: "div" },
  }),
  block({
    type: "section",
    label: "Section",
    category: "layout",
    description:
      "A full-width band of the page that groups related content — a hero, a feature row, an FAQ. " +
      "Renders as <section>, so give it a label when it has no heading.",
    usageHints: [
      "Pages are a stack of sections; put headings, text, images and grids inside them.",
      "Sections cannot be nested. Use columns or a grid for layout inside one.",
      "Set an intent such as \"hero\" or \"testimonials\" so the section's purpose is clear later.",
    ],
    schema: z.object({ label: z.string().max(80).optional() }).strict(),
    defaults: { props: {}, styles: { base: { paddingY: "xl", paddingX: "md", width: "content" } } },
    children: "any",
    parents: ["root"],
    insertable: true,
    editorPanel: [{ name: "label", label: "Accessible label (when there is no heading)", kind: "text", maxLength: 80 }],
    semantics: { element: "section", landmark: "region" },
  }),
  block({
    type: "columns",
    label: "Columns",
    category: "layout",
    description: "Two to four side-by-side columns that stack on small screens.",
    usageHints: ["Each child must be a column block.", "Image beside text is a two-column layout."],
    schema: z.object({ stackBelow: z.enum(["sm", "md", "lg"]).default("md") }).strict(),
    defaults: { props: { stackBelow: "md" }, styles: { base: { gap: "lg" } } },
    children: ["column"],
    maxChildren: 4,
    insertable: true,
    editorPanel: [
      {
        name: "stackBelow",
        label: "Stack on screens narrower than",
        kind: "select",
        options: [
          { value: "sm", label: "Phone (640px)" },
          { value: "md", label: "Tablet (768px)" },
          { value: "lg", label: "Laptop (1024px)" },
        ],
      },
    ],
    semantics: { element: "div" },
  }),
  block({
    type: "column",
    label: "Column",
    category: "layout",
    description: "One column inside a columns block.",
    usageHints: ["Only valid directly inside columns."],
    schema: z.object({}).strict(),
    defaults: { props: {} },
    children: "any",
    parents: ["columns"],
    insertable: true,
    editorPanel: [],
    semantics: { element: "div" },
  }),
  block({
    type: "grid",
    label: "Grid",
    category: "layout",
    description: "A responsive grid that fits as many equal items per row as the width allows.",
    usageHints: ["Use for a set of similar cards — features, logos, testimonials."],
    schema: z.object({ minItemWidth: z.enum(["sm", "md", "lg"]).default("md") }).strict(),
    defaults: { props: { minItemWidth: "md" }, styles: { base: { gap: "lg" } } },
    children: "any",
    insertable: true,
    editorPanel: [
      {
        name: "minItemWidth",
        label: "Item width",
        kind: "select",
        options: [
          { value: "sm", label: "Narrow" },
          { value: "md", label: "Medium" },
          { value: "lg", label: "Wide" },
        ],
      },
    ],
    semantics: { element: "div" },
  }),
  block({
    type: "spacer",
    label: "Spacer",
    category: "layout",
    description: "Vertical empty space. Prefer section padding where it does the job.",
    usageHints: ["Purely visual; hidden from assistive technology."],
    schema: z.object({ size: z.enum(SPACE_TOKENS).default("lg") }).strict(),
    defaults: { props: { size: "lg" } },
    children: "none",
    insertable: true,
    editorPanel: [
      { name: "size", label: "Size", kind: "select", options: SPACE_TOKENS.map((s) => ({ value: s, label: s })) },
    ],
    semantics: { element: "div" },
  }),
  block({
    type: "divider",
    label: "Divider",
    category: "layout",
    description: "A horizontal rule between two pieces of content.",
    usageHints: [],
    schema: z.object({}).strict(),
    defaults: { props: {} },
    children: "none",
    insertable: true,
    editorPanel: [],
    semantics: { element: "hr" },
  }),
  block({
    type: "heading",
    label: "Heading",
    category: "content",
    description:
      "A heading, h1 to h6. Headings are the page's outline — shoppers' screen readers and buying " +
      "agents both navigate by them.",
    usageHints: [
      "Exactly one level-1 heading per page: the page's main title.",
      "Do not skip levels (an h2 followed by an h4); publishing warns when you do.",
      "Write it as a short phrase, not a sentence.",
    ],
    schema: z
      .object({
        text: z.string().trim().min(1).max(200),
        level: z.number().int().min(1).max(6).default(2),
      })
      .strict(),
    defaults: { props: { text: "Heading", level: 2 } },
    children: "none",
    insertable: true,
    editorPanel: [
      { name: "text", label: "Text", kind: "text", maxLength: 200 },
      { name: "level", label: "Level", kind: "select", options: LEVELS.map((l) => ({ value: l, label: `H${l}` })) },
    ],
    semantics: { element: "h1–h6" },
  }),
  block({
    type: "text",
    label: "Text",
    category: "content",
    description:
      "Paragraphs of copy. Supports **bold**, *italic*, [links](/path), `-` bullet lists and `1.` " +
      "numbered lists. Headings are separate heading blocks; HTML is shown as plain text.",
    usageHints: [
      "Use only facts from the store's own data or what the merchant told you.",
      "Keep paragraphs short; split long copy across several text blocks under headings.",
    ],
    schema: z.object({ markdown: z.string().max(5000) }).strict(),
    defaults: { props: { markdown: "Tell shoppers something worth knowing." } },
    children: "none",
    insertable: true,
    editorPanel: [{ name: "markdown", label: "Text", kind: "markdown", maxLength: 5000 }],
    semantics: { element: "p / ul / ol" },
  }),
  block({
    type: "image",
    label: "Image",
    category: "media",
    description: "An image with alt text and an optional caption and link.",
    usageHints: [
      "Use images the store already has (product images or ones the merchant uploaded). Never invent an image URL.",
      "Alt text describes what the image shows for someone who cannot see it. Mark it decorative only when it adds nothing.",
    ],
    schema: z
      .object({
        // Optional so a freshly added image is valid; publishing refuses one with no source.
        src: imageUrl.optional(),
        alt: z.string().max(300).default(""),
        decorative: z.boolean().default(false),
        caption: z.string().max(300).optional(),
        href: link.optional(),
        aspect: z.enum(["auto", "1/1", "4/3", "16/9", "3/4"]).default("auto"),
      })
      .strict(),
    defaults: { props: { alt: "", decorative: false, aspect: "auto" } },
    children: "none",
    insertable: true,
    editorPanel: [
      { name: "src", label: "Image", kind: "image" },
      { name: "alt", label: "Alt text", kind: "text", maxLength: 300 },
      { name: "decorative", label: "Decorative (no alt text needed)", kind: "boolean" },
      { name: "caption", label: "Caption", kind: "text", maxLength: 300 },
      { name: "href", label: "Link", kind: "link" },
      {
        name: "aspect",
        label: "Shape",
        kind: "select",
        options: [
          { value: "auto", label: "Original" },
          { value: "1/1", label: "Square" },
          { value: "4/3", label: "4:3" },
          { value: "16/9", label: "16:9" },
          { value: "3/4", label: "Portrait" },
        ],
      },
    ],
    semantics: { element: "figure" },
  }),
  block({
    type: "button",
    label: "Button",
    category: "content",
    description: "A call-to-action link styled as a button.",
    usageHints: [
      "Link to a real place in the store: /collections, /search, a product page (/p/{slug}), or a page (/pages/{handle}).",
      "Say where it goes — \"Shop the collection\", not \"Click here\".",
    ],
    schema: z
      .object({
        label: z.string().trim().min(1).max(60),
        href: link,
        variant: z.enum(["primary", "secondary", "link"]).default("primary"),
      })
      .strict(),
    defaults: { props: { label: "Shop now", href: "/collections", variant: "primary" } },
    children: "none",
    insertable: true,
    editorPanel: [
      { name: "label", label: "Label", kind: "text", maxLength: 60 },
      { name: "href", label: "Link", kind: "link" },
      {
        name: "variant",
        label: "Style",
        kind: "select",
        options: [
          { value: "primary", label: "Primary" },
          { value: "secondary", label: "Secondary" },
          { value: "link", label: "Text link" },
        ],
      },
    ],
    semantics: { element: "a" },
  }),
  block({
    type: "list",
    label: "List",
    category: "content",
    description: "A bulleted or numbered list of short items.",
    usageHints: ["For a few short points. Longer copy reads better as a text block."],
    schema: z
      .object({
        items: z.array(z.string().trim().min(1).max(200)).min(1).max(30),
        ordered: z.boolean().default(false),
      })
      .strict(),
    defaults: { props: { items: ["First point", "Second point"], ordered: false } },
    children: "none",
    insertable: true,
    editorPanel: [
      { name: "items", label: "Items", kind: "stringList", maxItems: 30, maxLength: 200 },
      { name: "ordered", label: "Numbered", kind: "boolean" },
    ],
    semantics: { element: "ul / ol" },
  }),
  block({
    type: "accordion",
    label: "Accordion",
    category: "content",
    description: "Collapsible panels, each a title and body. Works without JavaScript.",
    usageHints: ["For details a shopper may want but most will skip — care instructions, sizing."],
    schema: z
      .object({
        items: z
          .array(z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(3000) }).strict())
          .min(1)
          .max(20),
      })
      .strict(),
    defaults: { props: { items: [{ title: "Panel title", body: "Panel text." }] } },
    children: "none",
    insertable: true,
    editorPanel: [
      {
        name: "items",
        label: "Panels",
        kind: "items",
        maxItems: 20,
        fields: [
          { name: "title", label: "Title", kind: "text", maxLength: 200 },
          { name: "body", label: "Body", kind: "markdown", maxLength: 3000 },
        ],
      },
    ],
    semantics: { element: "details" },
  }),
  block({
    type: "faq",
    label: "FAQ",
    category: "content",
    description:
      "Questions and answers. Also published as FAQPage structured data, which search engines and " +
      "buying agents read directly.",
    usageHints: [
      "Answer only from facts the merchant has given or the store's data — shipping, returns and policies especially.",
      "Ask the merchant before writing an answer you are not sure of.",
    ],
    schema: z
      .object({
        items: z
          .array(z.object({ question: z.string().trim().min(1).max(300), answer: z.string().trim().min(1).max(3000) }).strict())
          .min(1)
          .max(30),
      })
      .strict(),
    defaults: { props: { items: [{ question: "A common question?", answer: "Its answer." }] } },
    children: "none",
    insertable: true,
    editorPanel: [
      {
        name: "items",
        label: "Questions",
        kind: "items",
        maxItems: 30,
        fields: [
          { name: "question", label: "Question", kind: "text", maxLength: 300 },
          { name: "answer", label: "Answer", kind: "markdown", maxLength: 3000 },
        ],
      },
    ],
    semantics: { element: "details" },
  }),
  block({
    type: "testimonial",
    label: "Testimonial",
    category: "content",
    description: "A quotation from a customer, with who said it.",
    usageHints: [
      "Only real quotes the merchant supplied. Never invent a testimonial or a customer's name.",
    ],
    schema: z
      .object({
        quote: z.string().trim().min(1).max(1000),
        author: z.string().trim().min(1).max(100),
        role: z.string().max(100).optional(),
      })
      .strict(),
    defaults: { props: { quote: "The quote goes here.", author: "Customer name" } },
    children: "none",
    insertable: true,
    editorPanel: [
      { name: "quote", label: "Quote", kind: "text", maxLength: 1000 },
      { name: "author", label: "Name", kind: "text", maxLength: 100 },
      { name: "role", label: "Role or location", kind: "text", maxLength: 100 },
    ],
    semantics: { element: "figure" },
  }),
  block({
    type: "video",
    label: "Video",
    category: "media",
    description: "An embedded YouTube or Vimeo video.",
    usageHints: ["Only the merchant's own videos. The title is read aloud by screen readers."],
    schema: z
      .object({
        url: z.string().regex(VIDEO_HOSTS, "Use a YouTube or Vimeo link.").optional(),
        title: z.string().trim().min(1).max(200),
      })
      .strict(),
    defaults: { props: { title: "Video" } },
    children: "none",
    insertable: true,
    editorPanel: [
      { name: "url", label: "YouTube or Vimeo link", kind: "text", maxLength: 300 },
      { name: "title", label: "Title", kind: "text", maxLength: 200 },
    ],
    semantics: { element: "iframe" },
  }),
  block({
    type: "productGrid",
    label: "Product grid",
    category: "commerce",
    description: "A grid of the store's products: all of them, one category, or one collection.",
    usageHints: [
      "Uses live catalogue data — prices and stock are always current.",
      "Pick a category or collection with category_slug / collection_handle from the store's own lists.",
    ],
    schema: z
      .object({
        source: z.enum(["all", "category", "collection"]).default("all"),
        categorySlug: z.string().max(200).optional(),
        collectionHandle: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(48).default(12),
        showPrice: z.boolean().default(true),
      })
      .strict()
      .refine((p) => p.source !== "category" || Boolean(p.categorySlug), {
        message: "A category grid needs categorySlug.",
        path: ["categorySlug"],
      })
      .refine((p) => p.source !== "collection" || Boolean(p.collectionHandle), {
        message: "A collection grid needs collectionHandle.",
        path: ["collectionHandle"],
      }) as unknown as z.ZodObject,
    defaults: { props: { source: "all", limit: 12, showPrice: true } },
    children: "none",
    insertable: true,
    editorPanel: [
      {
        name: "source",
        label: "Show",
        kind: "select",
        options: [
          { value: "all", label: "All products" },
          { value: "category", label: "One category" },
          { value: "collection", label: "One collection" },
        ],
      },
      { name: "categorySlug", label: "Category", kind: "category" },
      { name: "collectionHandle", label: "Collection", kind: "collection" },
      { name: "limit", label: "How many", kind: "number", min: 1, max: 48 },
      { name: "showPrice", label: "Show prices", kind: "boolean" },
    ],
    semantics: { element: "ul" },
    requiresData: "catalog",
  }),
  block({
    type: "productCard",
    label: "Featured product",
    category: "commerce",
    description: "One product, shown as a card linking to its page.",
    usageHints: ["Use the product's slug from the store's catalogue."],
    schema: z.object({ productSlug: z.string().trim().min(1).max(200).optional() }).strict(),
    defaults: { props: {} },
    children: "none",
    insertable: true,
    editorPanel: [{ name: "productSlug", label: "Product", kind: "product" }],
    semantics: { element: "article" },
    requiresData: "catalog",
  }),
  block({
    type: "collectionList",
    label: "Collection list",
    category: "commerce",
    description: "Links to the store's published collections.",
    usageHints: ["Shows nothing until the store has published collections."],
    schema: z
      .object({
        limit: z.number().int().min(1).max(24).default(6),
        showDescriptions: z.boolean().default(true),
      })
      .strict(),
    defaults: { props: { limit: 6, showDescriptions: true } },
    children: "none",
    insertable: true,
    editorPanel: [
      { name: "limit", label: "How many", kind: "number", min: 1, max: 24 },
      { name: "showDescriptions", label: "Show descriptions", kind: "boolean" },
    ],
    semantics: { element: "ul" },
    requiresData: "catalog",
  }),
];

export const BLOCKS: ReadonlyMap<string, BlockDefinition> = new Map(DEFINITIONS.map((d) => [d.type, d]));

export function getBlock(type: string): BlockDefinition | undefined {
  return BLOCKS.get(type);
}

export function blockTypes(): string[] {
  return [...BLOCKS.keys()];
}

/** Whether `childType` may sit directly inside `parentType`. */
export function canContain(parentType: string, childType: string): boolean {
  const parent = BLOCKS.get(parentType);
  const child = BLOCKS.get(childType);
  if (!parent || !child) return false;
  if (child.type === "root") return false;
  if (child.parents && !child.parents.includes(parentType)) return false;
  if (parent.children === "none") return false;
  if (parent.children === "any") return true;
  return parent.children.includes(childType);
}

/** A block's props with its defaults applied and its schema enforced. Throws a ZodError. */
export function parseProps(type: string, props: unknown): Record<string, unknown> {
  const def = BLOCKS.get(type);
  if (!def) throw new Error(`Unknown block type "${type}"`);
  return def.schema.parse(props ?? {}) as Record<string, unknown>;
}

/** The registry as the editor and the agent read it: JSON Schema for props, no functions. */
export function describeBlocks() {
  return DEFINITIONS.filter((d) => d.insertable).map((d) => ({
    type: d.type,
    label: d.label,
    category: d.category,
    description: d.description,
    usageHints: d.usageHints,
    children: d.children,
    maxChildren: d.maxChildren ?? null,
    parents: d.parents ?? null,
    defaults: d.defaults,
    editorPanel: d.editorPanel,
    semantics: d.semantics,
    props: z.toJSONSchema(d.schema, { io: "input", unrepresentable: "any" }),
  }));
}
