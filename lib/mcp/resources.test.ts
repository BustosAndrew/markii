import { describe, expect, it } from "vitest";
import { GROUND_RULES } from "./prompts";
import { readToolNames } from "./reads";
import {
  readResource,
  resourceList,
  ResourceNotFound,
  resourceTemplates,
  type ResourceCtx,
} from "./resources";

/**
 * The parts of the resource surface that need no database: the advertised
 * shapes, the URI grammar, and the one resource that is pure text.
 *
 * Everything with a store behind it is in `tests/integration/mcp-resources.test.ts`,
 * because the property worth proving there — that `markii://site/{slug}/llms.txt`
 * is byte for byte what the storefront serves — only exists across the wire.
 */

/** No handler is reached by anything asserted here. */
const CTX = { authorization: "Bearer test" } as unknown as ResourceCtx;

describe("mcp resources", () => {
  it("advertises unique markii:// uris, each with a mime type", () => {
    const list = resourceList();
    expect(list.length).toBeGreaterThan(0);

    const uris = list.map((r) => r.uri);
    expect(new Set(uris).size).toBe(uris.length);

    for (const r of list) {
      expect(r.uri.startsWith("markii://")).toBe(true);
      expect(r.mimeType).toBeTruthy();
      // A client renders these to a person choosing what to attach.
      expect(r.title).toBeTruthy();
      expect(r.description).toBeTruthy();
    }
  });

  it("does not leak the reader onto the wire shape", () => {
    for (const r of resourceList()) {
      expect(r).not.toHaveProperty("read");
    }
  });

  /**
   * The set is small **on purpose** — see the module comment. Mirroring every
   * read tool as a resource would give a model two ways to ask one question and
   * no rule for choosing, so this fails if the two surfaces ever converge.
   */
  it("stays smaller than the read-tool surface", () => {
    expect(resourceList().length).toBeLessThan(readToolNames().length);
  });

  it("templates are parameterised on slug and name a concrete document", () => {
    const templates = resourceTemplates();
    expect(templates.map((t) => t.uriTemplate)).toEqual([
      "markii://site/{slug}/llms.txt",
      "markii://site/{slug}/agent.md",
    ]);
    for (const t of templates) {
      expect(t.uriTemplate).toContain("{slug}");
      expect(t.mimeType).toBeTruthy();
    }
  });

  /**
   * One set of rules, not two. If the prompts' preamble is edited and this
   * resource is not, a client that pins the document and a client that runs a
   * prompt are told different things about what the server enforces.
   */
  it("serves the same ground rules the prompts carry", async () => {
    const [contents] = await readResource("markii://conventions", CTX);
    expect(contents.mimeType).toBe("text/markdown");
    expect(contents.text).toContain(GROUND_RULES);
    expect(contents.uri).toBe("markii://conventions");
  });

  it("names the refusals an agent will actually meet", async () => {
    const [contents] = await readResource("markii://conventions", CTX);
    for (const code of ["HUMAN_APPROVAL_REQUIRED", "FORBIDDEN", "TRIAL_ENDED"]) {
      expect(contents.text).toContain(code);
    }
  });

  it("rejects a uri outside the grammar", async () => {
    for (const uri of [
      "markii://nope",
      "https://markii.shop/llms.txt",
      "markii://site//llms.txt",
      // A document this server does not publish, on a shape that otherwise matches.
      "markii://site/demo/sitemap.xml",
      // No traversal into another store through the slug segment.
      "markii://site/a/b/llms.txt",
    ]) {
      await expect(readResource(uri, CTX)).rejects.toBeInstanceOf(ResourceNotFound);
    }
  });

  it("carries the offending uri on the refusal, for the client's error", async () => {
    await expect(readResource("markii://nope", CTX)).rejects.toMatchObject({
      uri: "markii://nope",
    });
  });
});
