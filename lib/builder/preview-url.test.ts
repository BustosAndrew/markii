import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePreviewRequest, previewBase, previewHost, previewSubdomainWorks } from "./preview-url";

/**
 * Where the live preview lives (D51, M2). The rule that matters most: in
 * production a draft is never served on the dashboard's own origin — only on
 * the preview host — so the path form must be refused where subdomains work.
 */
const token = "A".repeat(43);

afterEach(() => vi.unstubAllEnvs());

describe("preview URLs", () => {
  it("uses the preview host where subdomains work", () => {
    expect(previewSubdomainWorks("markii.shop")).toBe(true);
    expect(previewHost("markii.shop")).toBe("preview.markii.shop");
    expect(previewBase("tea", token, "https://markii.shop", "markii.shop")).toBe(`https://preview.markii.shop/t/${token}/tea`);
  });

  it("falls back to a path on the app where subdomains do not load", () => {
    for (const root of ["localhost", "markii.vercel.app", ""]) expect(previewSubdomainWorks(root), root).toBe(false);
    expect(previewBase("tea", token, "http://localhost:3000/", "localhost")).toBe(`http://localhost:3000/preview/t/${token}/tea`);
  });

  it("parses both forms into token, slug and the storefront path", () => {
    expect(parsePreviewRequest("preview.markii.shop", `/t/${token}/tea/p/mug`, "markii.shop")).toEqual({ token, slug: "tea", rest: "/p/mug" });
    expect(parsePreviewRequest("localhost", `/preview/t/${token}/tea`, "localhost")).toEqual({ token, slug: "tea", rest: "" });
  });

  it("refuses the path form in production, so no draft is served on the dashboard's origin", () => {
    expect(parsePreviewRequest("markii.shop", `/preview/t/${token}/tea`, "markii.shop")).toBeNull();
    expect(parsePreviewRequest("tea.markii.shop", `/preview/t/${token}/tea`, "markii.shop")).toBeNull();
  });

  it("refuses malformed tokens and slugs", () => {
    expect(parsePreviewRequest("preview.markii.shop", `/t/short/tea`, "markii.shop")).toBeNull();
    expect(parsePreviewRequest("preview.markii.shop", `/t/${token}/Bad_Slug`, "markii.shop")).toBeNull();
    expect(parsePreviewRequest("preview.markii.shop", `/`, "markii.shop")).toBeNull();
  });
});
