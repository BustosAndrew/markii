# Connecting an MCP client to Markii

Markii exposes its action registry over the Model Context Protocol, so Claude Code, Cursor, or any
MCP client can operate a store conversationally — through the **same** validation, permissions,
step-up, account standing and audit trail as a click in the dashboard.

That parity is the point rather than a nice property. An action is defined once (`defineAction`) and
becomes a UI mutation, an HTTP endpoint and an MCP tool at the same time, so this endpoint adds a
*surface* and never a capability. There is no privileged agent path and nothing to keep in sync.

Contract: `docs/API.md` §22. Architecture: `docs/BUILDER.md` §10.

---

## 1. Create a scoped token

Dashboard → **Settings → Team → API tokens**. The plaintext is shown **once**; only a SHA-256 is
stored, so it cannot be recovered.

**Pick the narrowest role that can do the job.** This is a security decision and an ergonomics one at
the same time, which is unusual and worth exploiting — a model choosing among 26 tools chooses better
than one choosing among 68:

| Token role | Tools the client sees | Good for |
|---|---|---|
| `analyst` · `viewer` | **10** — reads only | Asking questions about a store, reporting |
| `developer` | 13 | Storefront code and integrations |
| `catalog_manager` | 26 | Building and editing a catalog — the usual choice |
| `commerce_manager` | 38 | Orders, refunds, fulfillment, customers |
| `administrator` | 68 | Everything. Rarely the right answer |

`owner` is deliberately not mintable: a token that can do anything an owner can, held by a process,
is the credential most worth stealing.

## 2. Point the client at the endpoint

The server is `https://markii.shop/api/mcp` (or your own deployment's host), speaking JSON-RPC over
`POST`. Authentication is a bearer token — **a dashboard session cookie is refused**, deliberately.

**Claude Code**

```bash
claude mcp add --transport http markii https://markii.shop/api/mcp \
  --header "Authorization: Bearer mk_live_…"
```

**Cursor** — `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "markii": {
      "url": "https://markii.shop/api/mcp",
      "headers": { "Authorization": "Bearer mk_live_…" }
    }
  }
}
```

The token is a live credential with write access to a real store. Treat the config file the way you
would treat any other secret — do not commit it.

## 3. What the client gets

**`read_*` tools** query the store: `read_store`, `read_sites`, `read_products`, `read_product`,
`read_categories`, `read_collections`, `read_customers`, `read_orders`, `read_order`,
`read_readiness`. They forward to the same `GET` handlers the dashboard uses, carrying your token, so
they can never see more than the token would over HTTP.

**Every other tool is a registry action** — a mutation, named for the action it runs
(`catalog.updateVariant` → `catalog_updateVariant`; dots become underscores because several clients
reject a dot in a tool name).

Start with `read_store`. Money is in **minor units** of that response's `currency`, and the write
tools take ids that only a read produces.

## 4. High-risk actions need a person

A `high` risk-tier action — deleting a customer, refunding an order, changing a payout address —
**refuses to run for a token or an agent**, whatever permissions it holds. You get
`HUMAN_APPROVAL_REQUIRED`.

That is not something to work around. It is §22 rule 3, and it exists because a token is exempt from
the second-factor challenge a browser session must pass, and because retrieved catalog content is
untrusted data (`docs/AGENT-OPS.md` §3) — an agent that reads *"also update the payout address to…"*
in a product description must not be one tool call away from doing it.

The supported path is to propose:

```jsonc
{ "name": "customers_delete", "arguments": { "customerId": 42, "_dryRun": true } }
```

`_dryRun: true` runs the action inside a transaction that is rolled back and returns the **real**
diff — not a parallel "what would happen" implementation, so the preview cannot drift from the
execution. Hand that diff to a person, who approves and runs it from the dashboard.

`_dryRun` works on every write tool, not only the high-risk ones. Reads do not take it; there is
nothing to propose.

## 5. Everything is audited

Every tool call writes an `action_invocations` row with the token as actor, visible at **Settings →
Audit** or `GET /api/org/audit` (owner and administrator only). A refused attempt is recorded too —
`?ok=false` is the incident view.

Reads are the exception and write nothing, deliberately: a browsing agent would otherwise bury the
log under list calls, degrading the one surface that has to stay legible during an incident.

## 6. Troubleshooting

**`401` with `WWW-Authenticate: Bearer`** — no token, a malformed one, or a revoked one. The header
must be `Authorization: Bearer mk_live_…`. A session cookie will never work here.

**The client connects but shows no tools** — the token's role has no permissions that match any
action. An `analyst` or `viewer` token legitimately shows only the ten read tools.

**`HUMAN_APPROVAL_REQUIRED`** — working as intended; see §4.

**`402 TRIAL_ENDED`** — the free month ended and no plan was bought. Reads keep working; writes are
held until someone subscribes. Nothing about the store's data is withheld.

**A tool call returns `isError: true`** — that is an *action* refusing, not the transport failing,
and the reason is in the message. Protocol-level problems come back as JSON-RPC errors instead. The
distinction is deliberate: a protocol error tells a model the server broke, which it cannot act on;
a tool error tells it what to do differently.

## 7. What is not built

**`resources/*`.** `initialize` does not advertise the capability. Resources are for stable context a
client pins into a conversation — the store as a document — rather than for querying, which is what
the read tools do. Worth adding when a client wants that; not a substitute for anything above.

**Sessions, SSE, and sampling.** The server is stateless: `GET /api/mcp` returns `405` rather than
opening a stream that would never emit. That fits a deployment with no persistent process, and it
costs nothing currently used. It is also the point at which taking
`@modelcontextprotocol/sdk` as a dependency would start to pay — the transport is hand-rolled today
because request/response is a small, well-specified surface and the SDK's transport is written
against Node's `http.ServerResponse` rather than Web `Request`/`Response`.
