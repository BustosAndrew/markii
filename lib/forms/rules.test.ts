import { createElement } from "react";
import { prerender } from "react-dom/static";
import { describe, expect, it } from "vitest";
import { formFieldsSchema, type FormField } from "@markii/renderer/forms";
import { FormView } from "@markii/renderer/forms-view";
import { blockedBy, candidatePatterns, formLimitKeys, normalizeBlockPattern, notificationText, parseSubmission } from "./rules";

const fields: FormField[] = formFieldsSchema.parse([
  { name: "name", label: "Your name", type: "text", required: true },
  { name: "email", label: "Email", type: "email", required: true },
  { name: "topic", label: "Topic", type: "select", options: ["Order", "Wholesale"] },
  { name: "message", label: "Message", type: "textarea", required: true, maxLength: 50 },
  { name: "consent", label: "Email me back", type: "checkbox" },
]);

describe("parseSubmission", () => {
  it("keeps the answers with their labels, and only the fields the form asks for", () => {
    const r = parseSubmission(fields, { name: " Mei ", email: "Mei@Example.com", topic: "Order", message: "Hi\r\nthere", consent: "yes", extra: "dropped" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.email).toBe("mei@example.com");
    expect(r.values).toEqual([
      { name: "name", label: "Your name", value: "Mei" },
      { name: "email", label: "Email", value: "Mei@Example.com" },
      { name: "topic", label: "Topic", value: "Order" },
      { name: "message", label: "Message", value: "Hi\nthere" },
      { name: "consent", label: "Email me back", value: true },
    ]);
    expect(JSON.stringify(r)).not.toContain("dropped");
  });

  it("names every problem a forged post could carry", () => {
    const r = parseSubmission(fields, { name: "a\nb", email: "not-an-email", topic: "Something else", message: "x".repeat(51) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.field)).toEqual(["name", "email", "topic", "message"]);
    expect(parseSubmission(fields, {}).ok).toBe(false);
  });

  it("refuses a form definition that would be ambiguous", () => {
    expect(formFieldsSchema.safeParse([]).success).toBe(false);
    expect(formFieldsSchema.safeParse([{ name: "a", label: "A", type: "text" }, { name: "a", label: "B", type: "text" }]).success).toBe(false);
    expect(formFieldsSchema.safeParse([{ name: "a", label: "A", type: "select" }]).success).toBe(false);
  });
});

describe("blocklist", () => {
  it("stores an address, or a domain however it is typed", () => {
    expect(normalizeBlockPattern(" Spam@Example.COM ")).toBe("spam@example.com");
    expect(normalizeBlockPattern("@example.com")).toBe("@example.com");
    expect(normalizeBlockPattern("example.com")).toBe("@example.com");
    expect(normalizeBlockPattern("not a pattern")).toBeNull();
    expect(normalizeBlockPattern("a@")).toBeNull();
  });

  it("blocks the address, its domain and every parent domain — never a lookalike", () => {
    const list = ["spam@example.com", "@junk.test"];
    expect(blockedBy("SPAM@example.com", list)).toBe("spam@example.com");
    expect(blockedBy("anyone@junk.test", list)).toBe("@junk.test");
    expect(blockedBy("anyone@mail.junk.test", list)).toBe("@junk.test");
    expect(blockedBy("anyone@notjunk.test", list)).toBeNull();
    expect(blockedBy("ham@example.com", list)).toBeNull();
    expect(candidatePatterns("a@mail.junk.test")).toEqual(["a@mail.junk.test", "@mail.junk.test", "@junk.test"]);
  });
});

describe("rate limit keys", () => {
  it("hold a hash, never the address or the email", () => {
    expect(formLimitKeys.ip(1, "203.0.113.7")).not.toContain("203.0.113.7");
    expect(formLimitKeys.email(1, "Mei@Example.com")).toBe(formLimitKeys.email(1, "mei@example.com"));
    expect(formLimitKeys.email(1, "mei@example.com")).not.toContain("mei");
    expect(formLimitKeys.store(1)).not.toBe(formLimitKeys.store(2));
  });
});

describe("rendering", () => {
  it("is a plain form that posts to the store, with the browser's own checks", async () => {
    const { prelude } = await prerender(
      createElement(FormView, { form: { handle: "contact", name: "Contact", fields, submitLabel: "Send" }, action: "https://tea.markii.shop/api/forms/contact", returnPath: "/pages/contact" }),
    );
    const html = await new Response(prelude).text();
    const tag = /<form [^>]*>/.exec(html)![0];
    expect(tag).toContain('method="post"');
    expect(tag).toContain('action="https://tea.markii.shop/api/forms/contact"');
    expect(html).toContain('type="email"');
    expect(html).toContain('maxLength="50"');
    expect(html).toContain('name="_return" value="/pages/contact"');
    expect(html).not.toContain("<script");
  });

  it("emails every answer, labelled", () => {
    const text = notificationText("Tea", "Contact", [{ label: "Message", value: "Hello" }, { label: "Email me back", value: false }]);
    expect(text).toContain('"Contact" form on Tea');
    expect(text).toContain("Message:\nHello");
    expect(text).toContain("Email me back:\nNo");
  });
});
