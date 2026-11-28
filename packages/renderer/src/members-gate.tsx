/**
 * What a visitor sees in place of a members-only page or post they cannot read
 * (§18.9): who it is for, how to sign in, and what to buy to join. Drawn the
 * same on Markii and in an export. Plain links, no script — the body it stands
 * in for never reached the page, so there is nothing here to hide or reveal.
 *
 * A gate that will not say what to buy is a dead end, so the join links are
 * the point; with none (the merchant sells no product granting the tier) it
 * says so plainly rather than pointing at nothing.
 */

export type MembersGateProps = {
  /** "post" or "page" — what the visitor is being kept from. */
  what: "post" | "page";
  tierName: string | null;
  /** Where signing in happens. */
  signInHref: string;
  /** Products that grant the tier, as links. */
  join: { name: string; href: string }[];
};

export function MembersGate({ what, tierName, signInHref, join }: MembersGateProps) {
  return (
    <aside className="sf-gate sf-gate-locked sf-members-gate" aria-label="Members only">
      <p>
        <strong>Members only.</strong> {`This ${what} is for ${tierName ? `${tierName} members` : "members"}. `}
        <a href={signInHref}>Sign in</a> if you are one.
      </p>
      {join.length > 0 ? (
        <p>
          Join with{" "}
          {join.map((j, i) => (
            <span key={j.href}>
              {i > 0 ? (i === join.length - 1 ? " or " : ", ") : null}
              <a href={j.href}>{j.name}</a>
            </span>
          ))}
          .
        </p>
      ) : null}
    </aside>
  );
}

/** Shown to the merchant in the builder preview above content they can read but shoppers may not. */
export function MembersPreviewNote({ what, tierName }: { what: "post" | "page"; tierName: string | null }) {
  return (
    <p className="sf-gate" role="note">
      <strong>Members only.</strong>{" "}
      {`Shoppers without a ${tierName ? `${tierName} membership` : "membership"} see this ${what}'s title and a way to join, not its content.`}
    </p>
  );
}
