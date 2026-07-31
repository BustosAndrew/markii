import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Scoped API / MCP token minting and lookup (§16, §22 rule 6).
 *
 * The plaintext is returned **once** at creation and never stored. Only its
 * SHA-256 is persisted, so a leaked database dump yields no usable credentials.
 */

/** `mk_live_` marks these as production credentials to a secret scanner. */
const TOKEN_PREFIX = "mk_live_";
/** 32 bytes → 256 bits of entropy. Guessing is not a threat model at this size. */
const TOKEN_BYTES = 32;

export type MintedToken = {
  /** Shown once. Never persisted, never logged, never returned again. */
  plaintext: string;
  hash: string;
  /** Safe to display and store: identifies the token without authenticating it. */
  prefix: string;
};

export function mintToken(): MintedToken {
  const secret = randomBytes(TOKEN_BYTES).toString("base64url");
  const plaintext = `${TOKEN_PREFIX}${secret}`;
  return {
    plaintext,
    hash: hashToken(plaintext),
    prefix: `${TOKEN_PREFIX}${secret.slice(0, 6)}`,
  };
}

/**
 * A plain SHA-256, deliberately — not bcrypt or argon2.
 *
 * Password hashing is slow on purpose because passwords are low-entropy and
 * guessable. A 256-bit random token is not, so the slow KDF buys nothing and
 * costs a expensive hash on every API request. This is the same reasoning that
 * makes GitHub and Stripe store token digests rather than KDF hashes.
 */
export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Constant-time compare, so a hash cannot be recovered by timing the lookup. */
export function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Extracts a bearer token from an Authorization header, if it looks like ours. */
export function bearerFrom(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const value = match?.[1]?.trim();
  if (!value || !value.startsWith(TOKEN_PREFIX)) return null;
  return value;
}
