/**
 * Reduce user input to a bare hostname.
 *
 * Merchants paste `https://www.acme.com/`, `Acme.com.`, and `orders@acme.com`.
 * Each of those is a different DNS name or an outright rejection, and the
 * failure arrives later as a verification that never completes — so normalise
 * before anything is stored or looked up.
 *
 * Pure and dependency-free on purpose: `lib/domains/index.ts` is pulled into the
 * proxy bundle, and both the email identities (§24) and custom storefront
 * domains (§2) need the same answer. Two copies of this would drift, and the
 * drift would show up as a domain that verifies in one place and not the other.
 *
 * The accepted shape mirrors the CHECK constraints in `0018_email_plumbing.sql`
 * and `0031_site_domain_verification.sql`, so a rejection arrives as a message
 * rather than a 500 from the database.
 */
export function normalizeDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (value === "") return null;

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split("@").pop() ?? value;
  value = value.split("/")[0];
  value = value.split(":")[0];
  value = value.replace(/\.+$/, "");

  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)
    ? value
    : null;
}
