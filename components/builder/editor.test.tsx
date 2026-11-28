import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockDescription, CheckResult, PageNode } from "@/lib/api/builder";
import { describeBindings } from "@markii/renderer/bindings";

/**
 * The editor's two renders where being wrong costs the merchant (D51, M2):
 *
 * - the inspector is **generated** from a block's `editorPanel`, so a block
 *   whose fields do not appear cannot be edited by hand at all — and when the
 *   brand agent holds the pen, every field must be read-only, or the merchant
 *   types into a form the server will refuse;
 * - the publish dialog must not offer Publish while a check would block it.
 *
 * Only the network is stubbed.
 */

const { getDesignChecks } = vi.hoisted(() => ({ getDesignChecks: vi.fn() }));
vi.mock("@/lib/api/builder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/builder")>()),
  getDesignChecks,
}));

const { Inspector } = await import("./inspector");
const { PublishDialog } = await import("./dialogs");
const { PagesPanel } = await import("./panels");
const { LayerTree } = await import("./layer-tree");

const heading: BlockDescription = {
  type: "heading",
  label: "Heading",
  category: "content",
  description: "A heading.",
  usageHints: ["Exactly one level-1 heading per page."],
  children: "none",
  maxChildren: null,
  parents: null,
  defaults: { props: { text: "Heading", level: 2 } },
  editorPanel: [
    { name: "text", label: "Text", kind: "text", maxLength: 200 },
    { name: "level", label: "Level", kind: "select", options: [1, 2, 3].map((l) => ({ value: l, label: `H${l}` })) },
  ],
  semantics: { element: "h1–h6" },
  bindable: { text: ["text"] },
  requiresScope: null,
  props: {},
};
const node: PageNode = { id: "n_aaaaaaaaaa", type: "heading", props: { text: "Our story", level: 2 } };

const noop = () => {};
function inspector(
  disabled: boolean,
  opts: { scopes?: string[]; node?: PageNode; onBindings?: (p: Record<string, string | null>) => void; breakpoint?: "base" | "sm" | "md" | "lg" } = {},
) {
  return render(
    <Inspector
      node={opts.node ?? node}
      block={heading}
      breakpoint={opts.breakpoint ?? "base"}
      onBreakpoint={noop}
      disabled={disabled}
      data={{ products: [], categories: [], collections: [] }}
      paths={describeBindings()}
      scopes={opts.scopes ?? ["store"]}
      onProps={noop}
      onStyles={noop}
      onIntent={noop}
      onCustomClass={noop}
      onBindings={opts.onBindings ?? noop}
      onVisibility={noop}
      onDuplicate={noop}
      onRemove={noop}
      onCopy={noop}
      onSaveBlock={async () => true as const}
    />,
  );
}

beforeEach(() => getDesignChecks.mockReset());
afterEach(() => cleanup());

describe("the inspector", () => {
  it("renders exactly the fields the block declares, with their current values", () => {
    inspector(false);
    expect((screen.getByLabelText("Text") as HTMLInputElement).value).toBe("Our story");
    expect((screen.getByLabelText("Level") as HTMLSelectElement).value).toBe("2");
    expect(screen.getByText("Exactly one level-1 heading per page.")).toBeTruthy();
  });

  it("is entirely read-only while the agent holds the pen", () => {
    inspector(true);
    for (const el of [screen.getByLabelText("Text"), screen.getByLabelText("Level"), screen.getByRole("button", { name: "Delete" })]) {
      expect((el as HTMLInputElement).disabled, el.outerHTML.slice(0, 60)).toBe(true);
    }
    // M4: the data and visibility controls are writes too. Choosing which screen size to look at is not.
    for (const el of screen.getAllByRole("combobox")) {
      if (el.getAttribute("aria-label") === "Screen size these styles apply to") continue;
      expect((el as HTMLSelectElement).disabled, el.id).toBe(true);
    }
  });
});

describe("the inspector at a breakpoint (M7)", () => {
  const styled: PageNode = { ...node, styles: { base: { paddingY: "lg" }, md: { color: "accent" } } };

  it("says what an unset style inherits, and from which size", () => {
    inspector(false, { node: styled, breakpoint: "lg" });
    const padding = document.getElementById("s-paddingY") as HTMLSelectElement;
    expect(padding.value).toBe("");
    expect(padding.selectedOptions[0].textContent).toBe("Inherit: lg (All screens)");
    const color = document.getElementById("s-color") as HTMLSelectElement;
    expect(color.selectedOptions[0].textContent).toBe("Inherit: accent (768px and up)");
    expect((document.getElementById("s-gap") as HTMLSelectElement).selectedOptions[0].textContent).toBe("Inherit: default");
  });

  it("marks what is set at this size", () => {
    inspector(false, { node: styled, breakpoint: "md" });
    expect(screen.getByText("1 set at this size.", { exact: false })).toBeTruthy();
    expect(screen.getByText("(set at this size)")).toBeTruthy();
  });
});

describe("the layer tree (M7)", () => {
  const blocks = new Map<string, BlockDescription>([
    ["section", { ...heading, type: "section", label: "Section", children: "any", parents: null }],
    ["heading", heading],
  ]);
  const h = (id: string, text: string): PageNode => ({ id, type: "heading", props: { text, level: 2 } });
  const root: PageNode = {
    id: "n_rootrootro",
    type: "root",
    props: {},
    children: [{ id: "n_sectionaaa", type: "section", props: {}, children: [h("n_aaaaaaaaaa", "A"), h("n_bbbbbbbbbb", "B"), h("n_cccccccccc", "C")] }],
  };
  const tree = (selection: string[], handlers: Partial<{ onSelect: () => void; onMoveMany: () => Promise<boolean>; onMove: () => Promise<boolean> }> = {}) =>
    render(
      <LayerTree
        root={root}
        registry={blocks}
        selection={selection}
        onSelect={handlers.onSelect ?? noop}
        onMove={handlers.onMove ?? (async () => true)}
        onMoveMany={handlers.onMoveMany ?? (async () => true)}
        announce={noop}
        disabled={false}
      />,
    );
  const row = (id: string) => document.querySelector(`[data-layer="${id}"]`) as HTMLButtonElement;

  it("is one tab stop, on the selected layer", () => {
    tree(["n_bbbbbbbbbb"]);
    const stops = [...document.querySelectorAll("[data-layer]")].filter((el) => (el as HTMLElement).tabIndex === 0);
    expect(stops.map((el) => el.getAttribute("data-layer"))).toEqual(["n_bbbbbbbbbb"]);
  });

  it("selects with the arrow keys, extends with Shift, toggles with Ctrl+click", () => {
    const onSelect = vi.fn();
    tree(["n_aaaaaaaaaa"], { onSelect });
    fireEvent.keyDown(row("n_aaaaaaaaaa"), { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith("n_bbbbbbbbbb", "replace");
    fireEvent.keyDown(row("n_aaaaaaaaaa"), { key: "ArrowDown", shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith("n_bbbbbbbbbb", "range");
    fireEvent.click(row("n_cccccccccc"), { ctrlKey: true });
    expect(onSelect).toHaveBeenLastCalledWith("n_cccccccccc", "toggle");
  });

  it("moves a selected group with Alt+arrow as one bulk move", async () => {
    const onMoveMany = vi.fn(async () => true);
    const onMove = vi.fn(async () => true);
    tree(["n_aaaaaaaaaa", "n_bbbbbbbbbb"], { onMoveMany, onMove });
    fireEvent.keyDown(row("n_bbbbbbbbbb"), { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(onMoveMany).toHaveBeenCalledTimes(1));
    expect(onMove).not.toHaveBeenCalled();
    // A and B step down past C: [C, A, B].
    expect(onMoveMany).toHaveBeenCalledWith([
      { nodeId: "n_aaaaaaaaaa", parentId: "n_sectionaaa", index: 2 },
      { nodeId: "n_bbbbbbbbbb", parentId: "n_sectionaaa", index: 2 },
    ]);
  });
});

describe("the inspector's data bindings (M4)", () => {
  const optionsOf = () =>
    [...(document.getElementById("b-text") as HTMLSelectElement).options].map((o) => o.value).filter(Boolean);

  it("offers product fields only where the document has a product", () => {
    inspector(false, { scopes: ["store"] });
    expect(optionsOf()).toContain("store.name");
    expect(optionsOf().some((p) => p.startsWith("product."))).toBe(false);
    cleanup();
    inspector(false, { scopes: ["store", "product"] });
    expect(optionsOf()).toContain("product.title");
    // Only text paths for a text prop — never an image or a link.
    expect(optionsOf()).not.toContain("product.image");
    expect(optionsOf()).not.toContain("product.url");
  });

  it("shows a binding the document cannot satisfy rather than hiding it", () => {
    inspector(false, { scopes: ["store"], node: { ...node, bindings: { text: "product.title" } } });
    const select = document.getElementById("b-text") as HTMLSelectElement;
    expect(select.value).toBe("product.title");
    expect(select.selectedOptions[0].textContent).toMatch(/not available here/);
  });

  it("binds and unbinds through one action each", () => {
    const onBindings = vi.fn();
    inspector(false, { scopes: ["store", "product"], onBindings });
    const select = document.getElementById("b-text") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "product.title" } });
    expect(onBindings).toHaveBeenLastCalledWith({ text: "product.title" });
    fireEvent.change(select, { target: { value: "" } });
    expect(onBindings).toHaveBeenLastCalledWith({ text: null });
  });
});

describe("the publish dialog", () => {
  const dialog = () =>
    render(<PublishDialog open site={1} hasUnpublishedChanges onClose={noop} onPublish={async () => true} onDiscard={async () => true} />);
  const check = (severity: CheckResult["severity"], message: string): CheckResult => ({ severity, code: "X", message });

  it("lists blocking errors and will not offer Publish while they stand", async () => {
    getDesignChecks.mockResolvedValue({ results: [check("error", "An image block has no image chosen.")], blocking: 1 });
    dialog();
    await waitFor(() => expect(screen.getByText("An image block has no image chosen.")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows warnings but lets the merchant publish", async () => {
    getDesignChecks.mockResolvedValue({ results: [check("warning", "An image has no alt text.")], blocking: 0 });
    dialog();
    await waitFor(() => expect(screen.getByText("An image has no alt text.")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the page SEO form (M5)", () => {
  // builder.updatePage replaces seo whole: a save that sends one field wipes the rest.
  const page = { id: 5, handle: "shipping", title: "Shipping", deleted: false, published: true, path: "/pages/shipping", requiresTierId: null, updatedAt: "2026-11-12T00:00:00Z" };
  const seo = { description: "Delivery times", ogImage: "https://cdn.test/share.jpg", noindex: true };

  it("sends every field with each save, so editing one keeps the others", () => {
    const onRename = vi.fn();
    render(<PagesPanel pages={[page]} currentId={5} currentSeo={seo} disabled={false} onOpen={noop} onCreate={async () => true} onRename={onRename} onDelete={noop} onRestore={noop} />);
    const title = screen.getByLabelText("Search title");
    fireEvent.change(title, { target: { value: "Shipping & returns" } });
    fireEvent.blur(title);
    expect(onRename).toHaveBeenLastCalledWith(5, { seo: { title: "Shipping & returns", ...seo } });
  });

  it("says that hiding a page hides it from agents too, and saves the switch at once", () => {
    const onRename = vi.fn();
    render(<PagesPanel pages={[page]} currentId={5} currentSeo={{ description: "Delivery times" }} disabled={false} onOpen={noop} onCreate={async () => true} onRename={onRename} onDelete={noop} onRestore={noop} />);
    fireEvent.click(screen.getByRole("switch", { name: "Hide from search engines and AI agents" }));
    expect(onRename).toHaveBeenLastCalledWith(5, { seo: { description: "Delivery times", noindex: true } });
  });
});
