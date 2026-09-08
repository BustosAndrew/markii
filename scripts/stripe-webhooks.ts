/**
 * Reports whether Stripe is still configured to send the events Markii depends
 * on (§17, §18, `lib/payments/webhook-events.ts`).
 *
 * Run: `pnpm stripe:webhooks`
 *
 * **Why this exists.** The receiving half is well covered — signatures are
 * verified, events are claimed by id, every handler is tested. The *sending*
 * half is configuration in someone's Stripe dashboard, and nothing in this
 * codebase can see it. Unsubscribing an event there produces no error, no log
 * line and no failing test: the capability just stops. `invoice.created` on the
 * Connect endpoint is the sharp case — without it the pre-charge stop for a
 * halted store never fires (D45) and a lapsed merchant's members keep being
 * charged, caught only by the weaker `invoice.paid` refusal after the money has
 * moved.
 *
 * It is the same shape as `pnpm stripe:prices`: derive what is expected from one
 * module the app also reads, ask Stripe what is actually there, report the
 * difference, and change nothing.
 *
 * **Read-only, always.** It creates and edits nothing, so it is safe to run
 * against a live key — and it *should* be, because live is the configuration
 * that bills real merchants. Run it with the live key after any dashboard edit.
 *
 * **How the rail is decided.** Stripe returns no `connect` field on this
 * endpoint, so the tell is `application`: an endpoint listening to connected
 * accounts carries the platform's Connect application id (`ca_…`), and a
 * plain account endpoint has `application: null`. Verified against both live
 * endpoints. When that is somehow absent, the `account.*` events are the
 * fallback — they only ever concern connected accounts — and anything still
 * ambiguous is reported as `unknown` rather than guessed at.
 */
import {
  missingEvents,
  REQUIRED_CONNECT_EVENTS,
  REQUIRED_PLATFORM_EVENTS,
  type WebhookRail,
} from "../lib/payments/webhook-events";

const API = "https://api.stripe.com/v1";
/**
 * Mirrors the pin in `lib/billing/stripe-billing.ts`, `fee-invoice.ts` and
 * `commerce/membership-billing.ts` — the version this codebase *sends* with.
 */
/** Matches the version the webhook endpoints send; reasoning in
 *  `lib/billing/stripe-billing.ts`. */
const API_VERSION = "2026-07-29.dahlia";

type EndpointRow = {
  id: string;
  url: string;
  status: string;
  enabled_events: string[];
  application: string | null;
  api_version: string | null;
  /**
   * Not returned by this endpoint at all in practice — checked against both
   * live endpoints, where the key is simply absent. Kept because Stripe
   * documents it on create, and an account that does return it should be
   * believed over any inference.
   */
  connect?: boolean;
  livemode: boolean;
  description: string | null;
};

async function listEndpoints(
  secret: string,
): Promise<{ ok: true; data: EndpointRow[] } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = await fetch(`${API}/webhook_endpoints?limit=100`, {
      headers: { authorization: `Bearer ${secret}`, "Stripe-Version": API_VERSION },
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "network error" };
  }
  const json = (await res.json().catch(() => ({}))) as {
    data?: EndpointRow[];
    error?: { message?: string };
  };
  if (!res.ok) return { ok: false, message: json.error?.message ?? `HTTP ${res.status}` };
  return { ok: true, data: json.data ?? [] };
}

/**
 * Which rail an endpoint serves.
 *
 * `connect` is authoritative when Stripe returns it. Otherwise the events
 * themselves are the tell: `account.updated` and `payment_intent.*` only ever
 * arrive from connected accounts, and `customer.subscription.*` on Markii's own
 * customers only from the platform. An endpoint carrying both, or neither,
 * is reported as `unknown` rather than guessed at — a wrong guess here would
 * report the wrong set of events as missing, which is worse than saying so.
 */
function railOf(e: EndpointRow): WebhookRail | "unknown" {
  if (typeof e.connect === "boolean") return e.connect ? "connect" : "platform";

  /**
   * **`application` is the discriminator.** An endpoint listening to connected
   * accounts is owned by the Connect application and carries its `ca_…` id; a
   * plain account endpoint has null.
   */
  if (e.application) return "connect";

  /**
   * Fallback, and the reason the first version of this got it wrong: an
   * endpoint's events are *not* a reliable tell. Only `account.*` is
   * Connect-exclusive. `customer.subscription.*` and `invoice.*` occur on both
   * rails — a merchant's connected account raises them for shopper memberships
   * (§18.9) exactly as Markii's platform account does for merchant plans — so
   * treating them as platform-exclusive reported the real Connect endpoint as
   * `unknown` and then announced that no Connect endpoint existed at all. A
   * verifier that cries wolf is worse than none.
   */
  const events = new Set(e.enabled_events);
  if (events.has("account.updated") || events.has("account.application.deauthorized")) {
    return "connect";
  }
  if (events.has("*")) return "unknown";
  return "platform";
}

function report(e: EndpointRow): { problems: number; lines: string[] } {
  const rail = railOf(e);
  const lines: string[] = [
    "",
    `  ${e.url}`,
    `    id=${e.id}  status=${e.status}  rail=${rail}${e.connect === undefined ? " (inferred)" : ""}`,
    `    api_version=${e.api_version ?? "account default"}  events=${e.enabled_events.length}`,
  ];
  let problems = 0;

  /**
   * A disabled endpoint receives nothing. Stripe disables one automatically
   * after enough consecutive failures, so this is a real state to find rather
   * than a hypothetical — and it is silent from the application's side, which
   * simply stops seeing events.
   */
  if (e.status !== "enabled") {
    problems++;
    lines.push(`    ✖ DISABLED — Stripe is sending nothing to this endpoint.`);
  }

  /**
   * **The endpoint decides the shape of what arrives, and it is set separately
   * from the version this code sends with.** Stripe renders an event body in
   * the endpoint's own `api_version`, so a handler written against the pinned
   * version can be parsing a different shape entirely — the exact hazard the
   * pin exists to prevent on the outbound side, arriving inbound. It is
   * reported rather than failed: a version difference is not proof of breakage,
   * most fields do not move, and calling it an error would train someone to
   * ignore the output. Read Stripe's changelog for the fields the handlers
   * actually touch before assuming it is fine.
   */
  if (e.api_version && e.api_version !== API_VERSION) {
    lines.push(
      `    ! renders events as ${e.api_version}, but this codebase pins ${API_VERSION}.`,
    );
    lines.push(
      "        Handlers parse whatever this endpoint sends, not the pinned shape.",
    );
  }

  if (rail === "unknown") {
    lines.push(
      "    ? Rail could not be determined from the API. Check it in the dashboard " +
        "(Developers → Webhooks → this endpoint) before trusting anything below.",
    );
    return { problems, lines };
  }

  const missing = missingEvents(rail, e.enabled_events);
  if (missing.length === 0) {
    lines.push(`    · every required ${rail} event is subscribed.`);
    return { problems, lines };
  }

  problems += missing.length;
  lines.push(`    ✖ ${missing.length} required ${rail} event(s) NOT subscribed:`);
  for (const m of missing) {
    lines.push(`        ${m.type}`);
    lines.push(`          → ${m.reason}`);
  }
  return { problems, lines };
}

async function main() {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    console.error(
      "\n✖ STRIPE_SECRET_KEY is not set.\n" +
        "  Add it to .env.local, or run with the live key to check the configuration that\n" +
        "  actually bills merchants:  STRIPE_SECRET_KEY=sk_live_… pnpm stripe:webhooks\n",
    );
    process.exitCode = 1;
    return;
  }

  const live = secret.startsWith("sk_live_");
  console.log(`\nStripe webhook endpoints — ${live ? "LIVE" : "test"} mode\n`);

  const result = await listEndpoints(secret);
  if (!result.ok) {
    console.error(`✖ Could not list endpoints: ${result.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (result.data.length === 0) {
    /**
     * Not automatically a fault in test mode: `stripe listen` registers an
     * ephemeral endpoint that never appears in this list, which is the normal
     * local setup. In live mode it means nothing is configured at all.
     */
    console.log(
      live
        ? "✖ No webhook endpoints exist. Nothing Markii depends on is being delivered:\n" +
            "  subscriptions never mirror, card orders never complete, memberships never renew.\n"
        : "  No registered endpoints in test mode.\n" +
            "  That is expected if you drive local development with `stripe listen`, which\n" +
            "  registers an ephemeral endpoint this API does not list. Re-run with the live\n" +
            "  key to check the configuration that bills merchants.\n",
    );
    if (live) process.exitCode = 1;
    return;
  }

  let problems = 0;
  const rails = new Set<string>();
  for (const endpoint of result.data) {
    const out = report(endpoint);
    problems += out.problems;
    rails.add(railOf(endpoint));
    console.log(out.lines.join("\n"));
  }

  /**
   * Both rails need an endpoint and they are separate ones (`docs/BACKEND.md`):
   * an endpoint with "Listen to events on Connected accounts" checked, and one
   * without. Having only one is a whole rail receiving nothing, which is worth
   * saying explicitly rather than leaving to be noticed from the list above.
   */
  for (const rail of ["connect", "platform"] as const) {
    if (!rails.has(rail)) {
      problems++;
      const required = rail === "connect" ? REQUIRED_CONNECT_EVENTS : REQUIRED_PLATFORM_EVENTS;
      console.log(
        `\n  ✖ No ${rail} endpoint found. ${required.length} required event(s) have nowhere to ` +
          `arrive.\n    ${rail === "connect" ? "Create one with \"Listen to events on Connected accounts\" checked, and set STRIPE_CONNECT_WEBHOOK_SECRET to its secret." : "Create one without the Connect option, and set STRIPE_WEBHOOK_SECRET to its secret."}`,
      );
    }
  }

  if (problems > 0) {
    console.error(
      `\n✖ ${problems} problem(s). Each one is a capability that fails silently — no error, ` +
        `no log line.\n`,
    );
    process.exitCode = 1;
    return;
  }

  console.log("\n✔ Every event Markii depends on is subscribed on both rails.\n");
}

/**
 * **`process.exitCode`, never `process.exit()`.**
 *
 * Node 25 on Windows aborts with a libuv assertion when the process is exited
 * while `fetch`'s handles are still closing, and the shell then sees a garbage
 * status — fatal for a script whose entire output is a pass/fail signal, and
 * worst in CI where nobody reads the text above it. Setting the code and
 * returning lets the event loop drain and exits with the right status.
 */
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
