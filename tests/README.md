# Tests

Two suites, separated by what they need to run.

```bash
pnpm test              # unit — fast, no dependencies. Run this constantly
pnpm test:watch        # unit, watching
pnpm test:integration  # needs a database and a running dev server (see below)
pnpm test:all          # both
```

## `pnpm test` — unit

Pure functions in `lib/**/*.test.ts`: discount amounts, tax extraction, shipping
rate eligibility, zone resolution, discount status. No database, no server, no
network. Runs in about a second, so there is no reason not to run it.

These cover **the arithmetic that decides what a shopper is charged**. Every
amount is integer minor units and every rate is basis points — the tests assert
that no float ever reaches a total, since that is a rule the type system cannot
enforce (`docs/DECISIONS.md` D31).

## `pnpm test:integration` — integration

`tests/integration/**/*.test.ts` drives real HTTP against a running dev server
and asserts against a real database.

**Prerequisites:**

```bash
DEMO_SKIP_PAYMENT_VERIFICATION=1 pnpm dev   # in another terminal
pnpm db:seed                                # if the demo store is missing
```

Then `pnpm test:integration`. Expect **several minutes** — every request is a
real round trip to a remote Supabase through the dev server, at roughly three
seconds each. That is the price of testing the wiring rather than a mock of it.

### Why these exist rather than more unit tests

Every bug worth catching so far lived in the wiring, not the arithmetic:

| Bug | Why a unit test could not see it |
|---|---|
| Setting a shipping rate wiped the cart's shipping address | The coercion was in a route handler's request parsing (`?? null` turning *absent* into *cleared*) |
| "Free over $50" withheld below the threshold **and** charged above it | Two functions each correct alone, contradicting each other about what one field meant |
| The metering base included tax and shipping | The number was self-consistent; only `docs/PRICING.md` §4.1 disagreed |
| A rejection's `reason.code` overwrote the shopper's discount code | An object spread in a response body |

The concurrency test is the clearest case: `docs/BACKEND.md` §4 requires the
last-unit race be solved "with a database transaction or constraint, not an
application-level read-then-write", and the only way to show that is eight
simultaneous checkouts against three units, through the real server, against
real Postgres.

### Safety

These tests **write to a real database**. Markii has one Supabase project, so
"the test database" and "the database" are currently the same thing. Three
guards sit in `setup.ts`:

1. `MARKII_ALLOW_INTEGRATION_TESTS=1` — set only by `pnpm test:integration`. A
   bare `vitest run` picks up every project, and this is what stops it.
2. A refusal to run against a `DATABASE_URL` containing `prod`/`production`.
3. An up-front dev-server check, so a failure reads as "start the server"
   rather than as sixty confusing assertion errors.

Every test also cleans up what it creates, via the `Cleanup` helper — which
fixes the deletion order once (usage records before orders before sites) rather
than at each call site, where getting it wrong leaves foreign-key debris.

**Tests assert against the database directly, not through the API that wrote the
value.** Checking a write by reading it back through the same code only proves
the code agrees with itself. The tenancy tests are the sharpest example: it is
not enough that org B gets a refusal — the row must be unchanged afterwards.

### Adding a test

Use `Client` for HTTP (it carries cookies), `signUpMerchant` for a real
authenticated merchant, and `Cleanup` for teardown in `afterAll`. Storefront
tests run against the seeded demo store via `demoStore()`; merchant tests create
their own org so they cannot collide.

`refused(r)` is the way to assert a registry action was rejected — refusals
arrive either as an HTTP 4xx or as an `ok: false` outcome depending on where the
failure happened, and callers care only that it was refused.
