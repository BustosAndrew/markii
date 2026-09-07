import { describe, expect, it } from "vitest";
import "../actions/index";
import { allActions, describeAction } from "../actions/registry";
import { readTools } from "./reads";
import { toolFor } from "./tools";

/**
 * Whether an MCP client can actually load these tools.
 *
 * A client converts each `inputSchema` into its model's function-calling
 * format, and that conversion is stricter than JSON Schema. A construct it
 * cannot express does not raise anything here — the tool is **silently dropped
 * from the model's toolset**, which looks exactly like the model choosing not
 * to use it. That failure is invisible from the server side, so it is worth
 * pinning here rather than discovering it in a transcript.
 *
 * This is the part of "test it with a real client" that can be mechanised. What
 * it cannot replace is a client's own quirks — see the note in the MCP section
 * of `docs/API.md`.
 */

/**
 * Constructs that are legal JSON Schema and poorly supported by function-calling
 * translators. `$ref`/`$defs` are the sharp ones: a schema that refers out to a
 * definitions block is frequently flattened wrongly or dropped.
 */
const POORLY_SUPPORTED = [
  "$ref",
  "$defs",
  "definitions",
  "unevaluatedProperties",
  "patternProperties",
  "dependentSchemas",
  "prefixItems",
  "not",
];

const allTools = () => [...readTools(), ...allActions().map((d) => toolFor(describeAction(d)))];

describe("MCP tool schemas are loadable by a client", () => {
  it("declares every tool's input as a plain object schema", () => {
    for (const tool of allTools()) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.properties, tool.name).toBeDefined();
    }
  });

  it.each(POORLY_SUPPORTED)("uses no %s anywhere in a tool schema", (keyword) => {
    const offenders = allTools()
      .filter((t) => JSON.stringify(t.inputSchema).includes(`"${keyword}"`))
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  /**
   * A name over 128 characters, or outside this set, is rejected outright by
   * several clients — and the rejection takes the whole listing with it in some.
   */
  it("keeps every tool name within the accepted charset and length", () => {
    for (const tool of allTools()) {
      expect(tool.name, tool.name).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    }
  });

  /**
   * The description is the only thing a model reads when choosing. An empty one
   * makes a tool unpickable; a very long one crowds out the rest of the toolset.
   */
  it("gives every tool a description of a usable length", () => {
    for (const tool of allTools()) {
      expect(tool.description.length, tool.name).toBeGreaterThan(10);
      expect(tool.description.length, tool.name).toBeLessThan(1024);
    }
  });

  it("names every tool exactly once across reads and actions", () => {
    const names = allTools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * Dates were already the cause of one outage here: `z.coerce.date()` has no
   * JSON Schema form and zod throws on it by default, which emptied
   * `GET /api/actions` for every caller. They must be described as strings, and
   * **never as `{}`** — "anything goes" tells an agent nothing about what is
   * wanted, and a confident wrong answer is worse than a loose one.
   *
   * A union counts as described so long as every branch is. Nullable fields
   * come out of zod as `anyOf: [{type: "string"}, {type: "null"}]`, which is the
   * standard shape every function-calling translator understands — an earlier
   * version of this test rejected those and was wrong to.
   */
  it("describes every property with a concrete type", () => {
    const described = (schema: Record<string, unknown>): boolean => {
      if (schema.type !== undefined || schema.enum !== undefined || schema.const !== undefined) {
        return true;
      }
      for (const key of ["anyOf", "oneOf"]) {
        const branches = schema[key];
        if (Array.isArray(branches) && branches.length > 0) {
          return branches.every((b) => described(b as Record<string, unknown>));
        }
      }
      return false;
    };

    const untyped: string[] = [];
    for (const tool of allTools()) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const [key, schema] of Object.entries(props)) {
        if (!described(schema)) untyped.push(`${tool.name}.${key}`);
      }
    }
    expect(untyped).toEqual([]);
  });

  /**
   * The specific regression: a property described as a bare `{}`. That is what
   * zod's `unrepresentable: "any"` produces for a type it cannot express, and it
   * passes every structural check above while telling an agent nothing.
   */
  it("has no property described as an empty schema", () => {
    const empty: string[] = [];
    for (const tool of allTools()) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, object>;
      for (const [key, schema] of Object.entries(props)) {
        if (Object.keys(schema).length === 0) empty.push(`${tool.name}.${key}`);
      }
    }
    expect(empty).toEqual([]);
  });
});
