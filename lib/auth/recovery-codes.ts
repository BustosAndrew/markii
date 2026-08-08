import "server-only";

import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import { db, mfaRecoveryCodes, type DbHandle } from "../db";

/**
 * MFA recovery codes (D40).
 *
 * The way back in when a merchant loses their phone. Supabase ships TOTP and no
 * backup codes, so this is the difference between "re-enrol from your laptop"
 * and "your store is gone until someone runs a service-role reset by hand".
 *
 * A recovery code is a **bearer credential equal in power to the second
 * factor** — presenting one is presenting proof of possession. Everything here
 * follows from that: they are shown exactly once, stored only as hashes,
 * compared in constant time, and consumed on use.
 */

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

/** Ten is the usual count: enough to print and lose a few, few enough to keep. */
const CODE_COUNT = 10;
/**
 * Crockford base32 without `I`, `L`, `O`, `U` — the characters people misread
 * when copying a code off paper under stress, which is the only situation in
 * which a recovery code is ever typed.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 20 characters over a 32-symbol alphabet = 100 bits. Not guessable. */
const CODE_LENGTH = 20;

/**
 * Formatted `XXXXX-XXXXX-XXXXX-XXXXX` for transcription; the dashes are
 * cosmetic and stripped before hashing, so a merchant typing it without them
 * still works.
 */
function formatCode(raw: string): string {
  return raw.match(/.{1,5}/g)!.join("-");
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function generateCode(): string {
  /**
   * Rejection-free by construction: 32 divides 256, so masking a random byte to
   * 5 bits is uniform over the alphabet. A `% 32` on an unmasked byte would be
   * uniform too here, but only by luck of the alphabet size — the mask keeps it
   * correct if the alphabet ever changes length.
   */
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

async function hash(code: string, salt: string): Promise<string> {
  return (await scrypt(code, salt, 32)).toString("hex");
}

/**
 * Replaces a user's entire set and returns the plaintext **once**.
 *
 * Regeneration is destructive on purpose. Leaving old codes valid alongside new
 * ones means a merchant who regenerates because they think a code leaked has not
 * actually revoked anything — which is the only reason anyone regenerates.
 *
 * The caller must show these and never store them. There is no way to read them
 * back, which is the point.
 */
export async function issueRecoveryCodes(
  userId: string,
  handle: DbHandle = db,
): Promise<string[]> {
  const codes = Array.from({ length: CODE_COUNT }, generateCode);

  const rows = await Promise.all(
    codes.map(async (code) => {
      /** Per-code salt: a shared one would let equal hashes reveal equal codes. */
      const salt = randomBytes(16).toString("hex");
      return {
        id: `rc_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        userId,
        codeHash: await hash(code, salt),
        salt,
      };
    }),
  );

  await handle.transaction(async (tx) => {
    // Replace, never append — see above.
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    await tx.insert(mfaRecoveryCodes).values(rows);
  });

  return codes.map(formatCode);
}

/**
 * Spends a code, or refuses.
 *
 * **Every unused code is hashed and compared even after a match**, so the work
 * done does not depend on which code was supplied or whether one matched at all.
 * Returning early on the first hit would leak, through timing, how far down the
 * list a guess landed.
 *
 * The consuming update is conditional on `used_at IS NULL`, so two simultaneous
 * uses of one code cannot both succeed — the second updates zero rows and is
 * refused. A recovery code is single-use, and "single" has to survive a
 * double-submitted form.
 */
export async function consumeRecoveryCode(
  userId: string,
  input: string,
  handle: DbHandle = db,
): Promise<{ ok: true; remaining: number } | { ok: false; reason: string }> {
  const code = normalizeCode(input);
  if (code.length !== CODE_LENGTH) {
    return { ok: false, reason: "That is not a recovery code." };
  }

  const rows = await handle
    .select()
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));

  if (rows.length === 0) {
    return { ok: false, reason: "No unused recovery codes remain on this account." };
  }

  let matched: (typeof rows)[number] | null = null;
  for (const row of rows) {
    const candidate = Buffer.from(await hash(code, row.salt), "hex");
    const stored = Buffer.from(row.codeHash, "hex");
    /**
     * `timingSafeEqual` throws on a length mismatch, which would itself be a
     * signal. Lengths are fixed by `hash`, so the guard is belt-and-braces
     * against a row written by an older format.
     */
    if (candidate.length === stored.length && timingSafeEqual(candidate, stored)) {
      matched ??= row;
    }
  }

  if (!matched) return { ok: false, reason: "That recovery code is not valid." };

  const consumed = await handle
    .update(mfaRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(mfaRecoveryCodes.id, matched.id), isNull(mfaRecoveryCodes.usedAt)))
    .returning({ id: mfaRecoveryCodes.id });

  if (consumed.length === 0) {
    // Lost the race: another request spent this same code first.
    return { ok: false, reason: "That recovery code has already been used." };
  }

  return { ok: true, remaining: rows.length - 1 };
}

/** How many are left, for the warning a merchant should see before they run out. */
export async function remainingRecoveryCodes(
  userId: string,
  handle: DbHandle = db,
): Promise<number> {
  const rows = await handle
    .select({ id: mfaRecoveryCodes.id })
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
  return rows.length;
}
