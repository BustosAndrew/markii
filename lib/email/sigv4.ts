import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4, for the SES v2 REST API.
 *
 * **Hand-rolled rather than `@aws-sdk/client-sesv2`, deliberately.** SES v2 is a
 * plain JSON REST API and this file is the entire client — signing is ~50 lines
 * of well-specified HMAC. The SDK would pull a large dependency tree onto a path
 * that runs inside order completion, for four endpoints. The same reasoning
 * already applies to Resend in `resend.ts`.
 *
 * The cost is that the signing has to be right, so it is tested against the
 * canonical AWS test vectors in `sigv4.test.ts` rather than only against "did a
 * real request work".
 */

const ALGORITHM = "AWS4-HMAC-SHA256";

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present only for temporary credentials (STS / instance roles). */
  sessionToken?: string;
};

function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** `20260801T123456Z` and `20260801` — the two forms every part of SigV4 wants. */
function stamps(date: Date): { amzDate: string; dateStamp: string } {
  const amzDate = `${date.toISOString().replace(/[:-]|\.\d{3}/g, "")}`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * URI-encode per RFC 3986, which is stricter than `encodeURIComponent`:
 * `!`, `'`, `(`, `)` and `*` must be escaped or the signature will not match.
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Encode a path for signing. Each segment is escaped, but the separators are
 * not — `/v2/email/identities/acme.com` keeps its slashes and would otherwise
 * sign as a single opaque segment.
 */
function canonicalPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join("/");
}

export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export type SignedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

/**
 * The canonical request and the resulting signature, given a complete header
 * set.
 *
 * Split out from {@link signRequest} because this is the part that is easy to
 * get subtly wrong and impossible to debug from a `403 SignatureDoesNotMatch`.
 * Exposed with the headers as an argument so it can be driven directly by AWS's
 * own published test vectors, which fix the header set — `signRequest` adds
 * headers of its own and could not reproduce them.
 */
export function signCanonical(input: {
  method: string;
  path: string;
  query: string;
  /** Lowercased header names. Every one is signed. */
  headers: Record<string, string>;
  payloadHash: string;
  amzDate: string;
  dateStamp: string;
  region: string;
  service: string;
  secretAccessKey: string;
}): { canonicalRequest: string; stringToSign: string; signature: string; signedHeaders: string } {
  const names = Object.keys(input.headers).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${input.headers[name].trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(input.path),
    input.query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${input.dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [ALGORITHM, input.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(
    signingKey(input.secretAccessKey, input.dateStamp, input.region, input.service),
    stringToSign,
  ).toString("hex");

  return { canonicalRequest, stringToSign, signature, signedHeaders };
}

/**
 * Sign a request. Returns headers ready to hand to `fetch`.
 *
 * `date` is injectable so the test vectors — which fix a timestamp — can run
 * without freezing the clock globally.
 */
export function signRequest(input: {
  method: string;
  host: string;
  path: string;
  /** Already-encoded query string without the leading `?`, or empty. */
  query?: string;
  body?: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  headers?: Record<string, string>;
  date?: Date;
}): SignedRequest {
  const { amzDate, dateStamp } = stamps(input.date ?? new Date());
  const body = input.body ?? "";
  const payloadHash = sha256Hex(body);

  /**
   * `x-amz-content-sha256` is signed as well as sent. Without it a proxy could
   * alter the body and the signature would still verify, since the hash would
   * only exist in the canonical request that the proxy also controls.
   */
  const headers: Record<string, string> = {
    host: input.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(input.credentials.sessionToken
      ? { "x-amz-security-token": input.credentials.sessionToken }
      : {}),
    ...Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const { signature, signedHeaders } = signCanonical({
    method: input.method,
    path: input.path,
    query: input.query ?? "",
    headers,
    payloadHash,
    amzDate,
    dateStamp,
    region: input.region,
    service: input.service,
    secretAccessKey: input.credentials.secretAccessKey,
  });

  return {
    url: `https://${input.host}${input.path}${input.query ? `?${input.query}` : ""}`,
    method: input.method.toUpperCase(),
    headers: {
      ...headers,
      Authorization:
        `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    ...(body ? { body } : {}),
  };
}
