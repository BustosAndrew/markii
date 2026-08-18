import type { z } from "zod";
import type { DbHandle, DiffEntry } from "../db";

export type { DiffEntry };

/**
 * Permissions are plain strings so the registry does not have to be edited every
 * time a scope is added. Phase A pins the authoritative set (`docs/API.md` §16);
 * until then the resolver decides, and it denies by default.
 */
export type Permission = string;

/**
 * `high` covers publishing, pricing, discounts, custom code, and bulk edits.
 * Per `docs/API.md` §22 rule 3 these **always** require human approval and
 * cannot be configured to auto-run — the tier governs execution regardless of
 * how confident the caller is.
 */
export type RiskTier = "read" | "low" | "medium" | "high";

export type Actor =
  | { type: "user"; id: string; orgId: string | null }
  | { type: "agent"; id: string; orgId: string | null; onBehalfOfUserId: string }
  | { type: "token"; id: string; orgId: string | null }
  /**
   * Migrations, seeds, and the scheduled billing sweep.
   *
   * **Authorizes everything and waives step-up**, so what may mint one is the
   * whole security question. Migrations and seeds run from a shell and are out
   * of reach by construction. The cron is not: `/api/cron/billing` is an HTTPS
   * endpoint, and `lib/cron/auth.ts` — holding `CRON_SECRET`, refusing when it
   * is unset — is the *only* code permitted to mint a system actor from a
   * request. Adding a second such caller means re-arguing both bypasses below.
   */
  | { type: "system"; id: string; orgId: string | null };

/**
 * A Drizzle handle — either the root client or a transaction. Actions receive
 * this and **must not** import `db` directly: dry-run works by running the real
 * action inside a transaction and rolling it back, which only holds if every
 * write goes through the handle it was given.
 */
export type ActionDb = DbHandle;

export type ActionContext = {
  actor: Actor;
  db: ActionDb;
  /**
   * This invocation's id, known before `run` starts so rows it writes can point
   * back at it. Several tables already reserve an `invocation_id` "so undo can
   * find it" — without this they could only ever store null.
   */
  invocationId: string;
  /** True when the caller asked what *would* happen. Nothing may escape the process. */
  dryRun: boolean;
  /** Server-checked, identical for humans, agents, and tokens (§22 rule 4). */
  can(permission: Permission): Promise<boolean>;
  /** Record a field-level change for the invocation's diff. */
  recordDiff(entry: DiffEntry): void;
  /**
   * Queue an effect the database cannot roll back — an email, a Stripe call, a
   * webhook. Skipped entirely on a dry run and flushed only after the
   * transaction commits, so a rolled-back action never leaks a side effect.
   */
  effect(description: string, fn: () => Promise<void>): void;
};

/**
 * A past invocation as the audit table holds it — everything an `inverse` is
 * allowed to see.
 *
 * `input` is **post-redaction**: what `redactInput` let through is all that was
 * ever stored, so an action that redacts the values its inverse would need
 * cannot be undone. That is a deliberate ordering — the audit row is long-lived
 * and widely readable, and keeping PII in it to enable undo would be the wrong
 * trade.
 */
export type RecordedInvocation = {
  invocationId: string;
  actionId: string;
  input: unknown;
  result: unknown;
  diff: DiffEntry[];
};

/** The forward invocation that reverses a recorded one. */
export type ActionInverse = {
  /**
   * Usually the same action with the previous values, sometimes its opposite
   * number — `email.suppressAddress` undoes with `email.unsuppressAddress`.
   */
  actionId: string;
  input: unknown;
  /**
   * Whether the recorded `after` must still be the current value before the
   * inverse is applied.
   *
   * `strict` (the default) dry-runs the inverse first and refuses when what is
   * there now is not what this invocation left behind — otherwise undoing a
   * price edit silently discards whatever someone changed in the meantime.
   * It narrows that window; it does not lock the row.
   *
   * `none` is for actions where the check is meaningless or wrong: an
   * append-only ledger (`inventory.adjust`, where the inverse entry is correct
   * regardless of intervening sales), and anything whose truth lives at a third
   * party rather than in a column we can compare.
   */
  conflictCheck?: "strict" | "none";
};

export type ActionDefinition<TInput = unknown, TResult = unknown> = {
  /** Dotted and stable — `catalog.updateProduct`. It is a public API name. */
  id: string;
  /** Written for an agent as much as a human: what it does, and when to reach for it. */
  description: string;
  input: z.ZodType<TInput>;
  permission: Permission;
  riskTier: RiskTier;
  /**
   * Requires a **fresh** second factor before it runs (D40 step-up).
   *
   * Separate from `riskTier`, because they answer different questions. `high`
   * means "a human must approve this" — an agent may propose it. Step-up means
   * "prove you are still at the keyboard", and the threat is the unattended
   * laptop rather than the confident agent. An action can need either, both, or
   * neither.
   *
   * Set it on anything that moves money or grants access: the x402 wallet
   * address (the payout destination), payment-rail toggles, staff roles and
   * invites, API tokens, and disabling MFA itself.
   *
   * **It is checked in `invokeAction`, not in a route handler.** §22 rule 1 means
   * there is one mutation path, so the check here covers the UI, the HTTP API,
   * agent tools, and MCP at once — and an agent cannot route around it. A
   * per-route check would leave exactly that gap.
   */
  requiresStepUp?: boolean;
  /**
   * Whether this action can be undone (§22).
   *
   * **It is not a free-text claim.** `defineAction` refuses a definition that
   * sets this without an `inverse`, and refuses an `inverse` without this — so
   * the flag the registry publishes and the audit table stores cannot say
   * "undoable" about something with no way back. It said exactly that on
   * twenty-one actions before undo was built, four of which turned out not to
   * be invertible at all.
   */
  undoable?: boolean;
  /**
   * Build the forward invocation that reverses a past one (`lib/actions/undo.ts`).
   *
   * **Undo is a new forward action, never a rollback.** The returned invocation
   * goes through `invokeAction` like any other, so it re-checks permissions and
   * step-up, re-validates its input, and is itself audited. A merchant who has
   * lost a permission since cannot undo their way around that.
   *
   * **It is pure and synchronous, and that is the point.** It may read only the
   * audit record — input, result, and diff — and never the database. So an
   * action is undoable exactly when its own record contains enough to reverse
   * it, which is a property that can be tested rather than asserted. An action
   * that redacts the values undo would need (`customers.update`) or records a
   * `before` it cannot tell apart from absent is honestly not undoable.
   *
   * Return `null` when *this particular* invocation cannot be reversed even
   * though the action generally can — `memberships.grant` extending an existing
   * membership has no inverse, while the same action creating one does.
   */
  inverse?(recorded: RecordedInvocation): ActionInverse | null;
  /**
   * Strip secrets before the input reaches the audit table. The audit row is
   * long-lived and widely readable; a raw API key in it is a breach waiting.
   */
  redactInput?: (input: TInput) => unknown;
  run(input: TInput, ctx: ActionContext): Promise<TResult>;
};

export type InvocationOutcome<TResult = unknown> = {
  invocationId: string;
  ok: boolean;
  result?: TResult;
  diff: DiffEntry[];
  undoable: boolean;
  dryRun: boolean;
};
