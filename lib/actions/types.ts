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
  /** Migrations, seeds, cron. Never reachable over HTTP. */
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
  /** Whether an inverse can be recorded. Undo itself arrives with Phase C's first undoable action. */
  undoable?: boolean;
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
