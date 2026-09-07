import { describe, expect, it } from "vitest";
import { findPrompt, PROMPTS, promptList, renderPrompt } from "./prompts";

/**
 * The prompts a merchant invokes by name.
 *
 * These are instructions that go straight into a model's context with a live
 * store credential attached, so what they *say* is the behaviour. A prompt that
 * forgets to mention minor units, or that tells an agent to go ahead and write,
 * is a bug with real money behind it — and nothing else in the system would
 * catch it.
 */

const render = (name: string, args: Record<string, string> = {}) => {
  const prompt = findPrompt(name);
  if (!prompt) throw new Error(`no prompt ${name}`);
  return renderPrompt(prompt, args).messages[0].content.text;
};

describe("the prompt list", () => {
  it("stays short enough to be a menu a person reads", () => {
    expect(PROMPTS.length).toBeLessThanOrEqual(6);
    expect(PROMPTS.length).toBeGreaterThan(0);
  });

  it("names every prompt uniquely and in the accepted charset", () => {
    const names = PROMPTS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9_-]{1,64}$/);
  });

  it("gives each one a title, a description, and typed arguments", () => {
    for (const p of promptList()) {
      expect(p.title.length, p.name).toBeGreaterThan(0);
      expect(p.description.length, p.name).toBeGreaterThan(20);
      for (const arg of p.arguments) {
        expect(arg.description.length, `${p.name}.${arg.name}`).toBeGreaterThan(0);
        expect(typeof arg.required).toBe("boolean");
      }
    }
  });

  it("renders every prompt without an argument supplied", () => {
    // A client may call prompts/get with nothing; none of these may throw.
    for (const p of PROMPTS) {
      expect(() => renderPrompt(p, {}), p.name).not.toThrow();
      expect(renderPrompt(p, {}).messages[0].content.text.length).toBeGreaterThan(50);
    }
  });

  it("renders as a user message, not a system one", () => {
    for (const p of PROMPTS) {
      expect(renderPrompt(p, {}).messages[0].role).toBe("user");
    }
  });
});

describe("every prompt carries the ground rules that stop expensive mistakes", () => {
  it.each(PROMPTS.map((p) => p.name))("%s states money is in minor units", (name) => {
    expect(render(name)).toMatch(/minor units/i);
  });

  it.each(PROMPTS.map((p) => p.name))("%s says to read before writing", (name) => {
    expect(render(name)).toMatch(/read.*before you write|do not guess an id/i);
  });

  /**
   * `docs/AGENT-OPS.md` §3: retrieved catalog and customer content is untrusted
   * data, never instruction. An agent holding a write credential and reading
   * merchant-authored text is exactly the prompt-injection surface, so every
   * prompt has to say so.
   */
  it.each(PROMPTS.map((p) => p.name))("%s treats store content as data, not instruction", (name) => {
    expect(render(name)).toMatch(/never as instructions|not as instructions/i);
  });

  it.each(PROMPTS.map((p) => p.name))("%s explains that high-risk tools refuse", (name) => {
    expect(render(name)).toMatch(/_dryRun/);
  });
});

describe("store_health", () => {
  it("scopes to one storefront when given one", () => {
    expect(render("store_health", { siteId: "42" })).toContain("42");
  });

  it("covers every storefront when not", () => {
    expect(render("store_health")).toMatch(/every storefront/i);
  });

  /** Proposing is the point; a prompt that greenlights edits defeats the gate. */
  it("forbids fixing anything before the merchant chooses", () => {
    expect(render("store_health")).toMatch(/do not fix\s+anything yet/i);
  });

  /** Never invent work — the house rule against fabricated findings. */
  it("says to report a healthy store as healthy", () => {
    expect(render("store_health")).toMatch(/manufacturing work|rather than manufacturing/i);
  });
});

describe("propose_change", () => {
  it("carries the merchant's request into the message", () => {
    expect(render("propose_change", { request: "raise all hoodie prices by 10%" })).toContain(
      "raise all hoodie prices by 10%",
    );
  });

  /**
   * The required argument can still arrive empty — a client may send the prompt
   * before the user types anything. It must ask rather than invent a request.
   */
  it("asks for the request rather than inventing one when it is missing", () => {
    expect(render("propose_change")).toMatch(/no request supplied|ask what they want/i);
  });

  it("forbids writing even where a tool would allow it", () => {
    expect(render("propose_change")).toMatch(/write nothing/i);
  });

  it("says to stop and ask on an ambiguous request", () => {
    expect(render("propose_change", { request: "fix the prices" })).toMatch(
      /stop and\s+ask/i,
    );
  });
});

describe("review_activity", () => {
  /**
   * The audit log is gated on `org.audit`, which no token holds — there is no
   * read tool for it. The prompt must not imply otherwise, or the model will
   * narrate a change history it cannot see.
   */
  it("states plainly that it cannot read the audit log", () => {
    const text = render("review_activity");
    expect(text).toMatch(/not.*available to you as a tool/i);
    expect(text).toMatch(/do not claim to have read it/i);
  });

  it("points the merchant at the dashboard for who changed what", () => {
    expect(render("review_activity")).toMatch(/Settings → Audit/);
  });

  /** Current state is not a change history, and inferring one fabricates facts. */
  it("forbids inferring a change history from current state", () => {
    expect(render("review_activity")).toMatch(/do not infer a change history/i);
  });

  it("passes a focus through when given one", () => {
    expect(render("review_activity", { focus: "refusals only" })).toContain("refusals only");
  });
});
