import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeRfc3986, signCanonical, signRequest, signingKey } from "./sigv4";

/**
 * AWS Signature Version 4.
 *
 * Tested against **AWS's own published vectors**, not against "a real request
 * worked once". A wrong signature produces `403 SignatureDoesNotMatch` with no
 * hint about which of the six canonical-request lines was malformed, and the
 * failure mode in production is that a merchant's order confirmations silently
 * stop — so this is worth pinning to external truth.
 */

const EXAMPLE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

describe("signingKey", () => {
  it("matches AWS's documented derivation example", () => {
    // From the SigV4 documentation: 20150830 / us-east-1 / iam.
    expect(signingKey(EXAMPLE.secretAccessKey, "20150830", "us-east-1", "iam").toString("hex")).toBe(
      "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
    );
  });

  it("derives a different key per day, region and service", () => {
    const base = signingKey(EXAMPLE.secretAccessKey, "20150830", "us-east-1", "ses").toString("hex");
    expect(signingKey(EXAMPLE.secretAccessKey, "20150831", "us-east-1", "ses").toString("hex")).not.toBe(base);
    expect(signingKey(EXAMPLE.secretAccessKey, "20150830", "eu-west-1", "ses").toString("hex")).not.toBe(base);
    expect(signingKey(EXAMPLE.secretAccessKey, "20150830", "us-east-1", "sns").toString("hex")).not.toBe(base);
  });
});

describe("signCanonical", () => {
  const EMPTY_SHA = createHash("sha256").update("").digest("hex");

  it("reproduces the get-vanilla test vector", () => {
    const result = signCanonical({
      method: "GET",
      path: "/",
      query: "",
      headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
      payloadHash: EMPTY_SHA,
      amzDate: "20150830T123600Z",
      dateStamp: "20150830",
      region: "us-east-1",
      service: "service",
      secretAccessKey: EXAMPLE.secretAccessKey,
    });

    expect(result.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        EMPTY_SHA,
      ].join("\n"),
    );
    expect(result.signature).toBe(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("sorts signed headers regardless of the order they were supplied", () => {
    const inOrder = signCanonical({
      method: "GET",
      path: "/",
      query: "",
      headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
      payloadHash: EMPTY_SHA,
      amzDate: "20150830T123600Z",
      dateStamp: "20150830",
      region: "us-east-1",
      service: "service",
      secretAccessKey: EXAMPLE.secretAccessKey,
    });
    const reversed = signCanonical({
      method: "GET",
      path: "/",
      query: "",
      headers: { "x-amz-date": "20150830T123600Z", host: "example.amazonaws.com" },
      payloadHash: EMPTY_SHA,
      amzDate: "20150830T123600Z",
      dateStamp: "20150830",
      region: "us-east-1",
      service: "service",
      secretAccessKey: EXAMPLE.secretAccessKey,
    });
    expect(reversed.signature).toBe(inOrder.signature);
  });

  it("keeps path separators unescaped but escapes the segments", () => {
    // `/v2/email/identities/acme.com` must stay four segments. Escaping the
    // slashes would sign a path SES never saw.
    const result = signCanonical({
      method: "GET",
      path: "/v2/email/identities/acme.com",
      query: "",
      headers: { host: "email.us-east-1.amazonaws.com" },
      payloadHash: EMPTY_SHA,
      amzDate: "20260801T000000Z",
      dateStamp: "20260801",
      region: "us-east-1",
      service: "ses",
      secretAccessKey: EXAMPLE.secretAccessKey,
    });
    expect(result.canonicalRequest.split("\n")[1]).toBe("/v2/email/identities/acme.com");
  });
});

describe("encodeRfc3986", () => {
  it("escapes the characters encodeURIComponent leaves alone", () => {
    // These five are the entire difference, and each one silently breaks a
    // signature rather than erroring.
    expect(encodeRfc3986("!'()*")).toBe("%21%27%28%29%2A");
  });

  it("still escapes the ordinary reserved characters", () => {
    expect(encodeRfc3986("a b/c?d")).toBe("a%20b%2Fc%3Fd");
  });
});

describe("signRequest", () => {
  const credentials = EXAMPLE;

  it("signs the payload hash as a header as well as sending it", () => {
    const signed = signRequest({
      method: "POST",
      host: "email.us-east-1.amazonaws.com",
      path: "/v2/email/outbound-emails",
      body: '{"a":1}',
      region: "us-east-1",
      service: "ses",
      credentials,
      headers: { "content-type": "application/json" },
      date: new Date("2026-08-01T00:00:00Z"),
    });

    const expected = createHash("sha256").update('{"a":1}').digest("hex");
    expect(signed.headers["x-amz-content-sha256"]).toBe(expected);
    expect(signed.headers.Authorization).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
  });

  it("produces a different signature when the body changes", () => {
    const at = new Date("2026-08-01T00:00:00Z");
    const common = {
      method: "POST" as const,
      host: "email.us-east-1.amazonaws.com",
      path: "/v2/email/outbound-emails",
      region: "us-east-1",
      service: "ses",
      credentials,
      date: at,
    };
    const a = signRequest({ ...common, body: '{"to":"a@example.com"}' });
    const b = signRequest({ ...common, body: '{"to":"b@example.com"}' });
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });

  it("includes the session token in the signed headers when there is one", () => {
    // Temporary credentials fail with a valid-looking signature if the token is
    // sent but not signed — the least obvious failure in this file.
    const signed = signRequest({
      method: "GET",
      host: "email.us-east-1.amazonaws.com",
      path: "/v2/email/identities",
      region: "us-east-1",
      service: "ses",
      credentials: { ...credentials, sessionToken: "tok" },
      date: new Date("2026-08-01T00:00:00Z"),
    });
    expect(signed.headers.Authorization).toContain("x-amz-security-token");
    expect(signed.headers["x-amz-security-token"]).toBe("tok");
  });

  it("builds the request URL from host, path and query", () => {
    const signed = signRequest({
      method: "GET",
      host: "email.eu-west-1.amazonaws.com",
      path: "/v2/email/identities",
      query: "PageSize=10",
      region: "eu-west-1",
      service: "ses",
      credentials,
    });
    expect(signed.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/identities?PageSize=10");
  });
});
