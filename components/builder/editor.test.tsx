import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockDescription, CheckResult, PageNode } from "@/lib/api/builder";
import { describeBindings } from "@/lib/builder/bindings";

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
function inspector(disabled: boolean, opts: { scopes?: string[]; node?: PageNode; onBindings?: (p: Record<string, string | null>) => void } = {}) {
  return render(
    <Inspector
      node={opts.node ?? node}
      block={heading}
      breakpoint="base"
      onBreakpoint={noop}
      disabled={disabled}
      data={{ products: [], categories: [], collections: [] }}
      paths={describeBindings()}
      scopes={opts.scopes ?? ["store"]}
      onProps={noop}
      onStyles={noop}
      onIntent={noop}
      onBindings={opts.onBindings ?? noop}
      onVisibility={noop}
      onDuplicate={noop}
      onRemove={noop}
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
    // M4: the data and visibility controls are writes too.
    for (const el of screen.getAllByRole("combobox")) expect((el as HTMLSelectElement).disabled, el.id).toBe(true);
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
