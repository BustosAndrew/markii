import { describe, expect, it } from "vitest";
import { requestContextFrom } from "./request-context";

function req(headers: Record<string, string>): Request {
  return new Request("https://markii.shop/api/actions/catalog.updateProduct", { headers });
}

describe("requestContextFrom", () => {
  it("takes the client from the leftmost x-forwarded-for entry", () => {
    const ctx = requestContextFrom(req({ "x-forwarded-for": "203.0.113.7, 70.41.3.18" }));
    expect(ctx.ip).toBe("203.0.113.7");
  });

  it("trims whitespace around the address", () => {
    expect(requestContextFrom(req({ "x-forwarded-for": "  203.0.113.7 " })).ip).toBe(
      "203.0.113.7",
    );
  });

  it("falls back to x-real-ip when there is no forwarded chain", () => {
    expect(requestContextFrom(req({ "x-real-ip": "198.51.100.4" })).ip).toBe("198.51.100.4");
  });

  it("prefers x-forwarded-for when both are present", () => {
    const ctx = requestContextFrom(
      req({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.4" }),
    );
    expect(ctx.ip).toBe("203.0.113.7");
  });

  /**
   * Null rather than a placeholder: an absent address must not be recorded in a
   * way a reader could mistake for a captured one.
   */
  it("reports null when no address header is present", () => {
    const ctx = requestContextFrom(req({}));
    expect(ctx.ip).toBeNull();
    expect(ctx.userAgent).toBeNull();
  });

  it("treats an empty forwarded header as no address", () => {
    expect(requestContextFrom(req({ "x-forwarded-for": "" })).ip).toBeNull();
  });

  it("records the user agent", () => {
    expect(requestContextFrom(req({ "user-agent": "Mozilla/5.0" })).userAgent).toBe(
      "Mozilla/5.0",
    );
  });

  /**
   * The user agent is attacker-controlled free text stored on every invocation,
   * so an unbounded one is a cheap way to bloat a table nobody prunes.
   */
  it("caps an oversized user agent rather than storing it whole", () => {
    const ctx = requestContextFrom(req({ "user-agent": "x".repeat(4000) }));
    expect(ctx.userAgent).toHaveLength(512);
  });
});
