import "server-only";

import { and, eq } from "drizzle-orm";
import { ApiError } from "../api";
import { db, sites } from "../db";
import { loadSite, storefrontHalted, type SiteData } from "../storefront";
import { renderAgentMd, renderLlmsTxt } from "../storefront-docs";
import { ownSitesForStaff } from "../tenancy";
import type { AuthContext } from "../auth/session";
import { GROUND_RULES } from "./prompts";
import { callReadTool, findReadTool } from "./reads";

/**
 * MCP resources (§22) — the store as **context a client pins**, rather than
 * something an agent queries.
 *
 * That distinction is the whole reason this file is short. The `read_*` tools
 * already answer questions, and duplicating them here would give a model two
 * ways to ask the same thing and no rule for choosing. What a resource is *for*
 * is the material a client attaches once and leaves in view: which organization
 * this credential belongs to, which storefronts exist, the rules this server
 * enforces, and what a shopper's agent actually sees when it visits a store.
 *
 * **Nothing here is a new authorization path.** The two org-level resources
 * forward to the same `GET` handlers the read tools use, carrying the caller's
 * own `Authorization` header — so `markii://store` and `read_store` cannot
 * disagree, being the same bytes from the same handler. The per-site documents
 * have no authenticated route to forward to, so they are scoped with
 * `ownSitesForStaff`, the same intersection `GET /api/sites` applies: org first,
 * then the staff member's own `storeIds`.
 *
 * **No permission beyond that scoping, deliberately.** The `llms.txt` and
 * `agent.md` bytes are served unauthenticated on the storefront's own domain —
 * that is their entire purpose — so gating them on a role here would imply a
 * confidentiality the document does not have. What matters is which *org's*
 * store a token may name, and that is enforced.
 */

export type McpResource = {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
};

export type McpResourceTemplate = Omit<McpResource, "uri"> & { uriTemplate: string };

export type ResourceContents = { uri: string; mimeType: string; text: string };

/** What a read needs: the caller, and the header its forwards re-present. */
export type ResourceCtx = { session: AuthContext; authorization: string };

/** Raised for an unknown URI, so the route can answer with the spec's own code. */
export class ResourceNotFound extends Error {
  readonly uri: string;

  constructor(uri: string) {
    super(
      `No resource at "${uri}". Call resources/list and resources/templates/list to see what ` +
        "exists.",
    );
    this.name = "ResourceNotFound";
    this.uri = uri;
  }
}

/**
 * The operating rules, as a document.
 *
 * The same text as the prompts' preamble, from the same constant. A prompt is
 * chosen by a person and lands once; this is pinned for a whole conversation —
 * two ways to receive one set of rules, never two sets.
 */
const CONVENTIONS = `# Operating a Markii store

${GROUND_RULES}

## What this server is

Every write tool is a registry action, validated by the same schema, checked
against the same permissions, and written to the same audit log as a click in
the merchant's dashboard. There is no privileged path here: if a tool refuses
you, a person doing the same thing in the browser would be refused too, for the
same reason.

## Refusals to expect, and what each one means

- HUMAN_APPROVAL_REQUIRED — the action is high-risk and will not run for a token
  or an agent. Re-issue it with "_dryRun": true and give the resulting diff to a
  person. This is the designed path, not a misconfiguration.
- FORBIDDEN — the token's role lacks the permission. A different tool will not
  help; the merchant has to widen the token or act themselves.
- TRIAL_ENDED — the account is not in good standing. Reads still work; writes do
  not until the merchant subscribes.
- MFA_REQUIRED / step-up — unreachable with a token, and no token can clear it.
  It belongs to the browser session path.

## Money

Integer minor units, always, with an explicit currency. Read markii://store for
the organization's currency before formatting anything: not every currency has
two decimal places, and dividing by 100 is wrong in JPY and KRW.
`;

type StaticResource = McpResource & {
  read: (ctx: ResourceCtx) => Promise<string>;
};

/**
 * Forwards to a read tool's route handler and returns its JSON verbatim.
 *
 * Going through `callReadTool` rather than the handler directly is what keeps
 * the resource and the tool identical: same path, same forwarded header, same
 * serializer. A failure is raised rather than returned, because a resource read
 * names one specific URI — there is no alternative for a model to pick, which is
 * exactly the case where an error belongs in the protocol rather than in a
 * result a model is meant to reason about.
 */
async function forwardRead(toolName: string, ctx: ResourceCtx): Promise<string> {
  const tool = findReadTool(toolName);
  if (!tool) throw new ApiError("INTERNAL", 500, `Missing read tool "${toolName}"`);

  const { status, body } = await callReadTool(tool, {}, ctx.authorization);
  if (status >= 400) {
    throw new ApiError("FORBIDDEN", status, `Could not read ${toolName}`, body);
  }
  return JSON.stringify(body, null, 2);
}

const STATIC_RESOURCES: StaticResource[] = [
  {
    uri: "markii://store",
    name: "store",
    title: "This organization",
    description:
      "The organization this credential belongs to: name, plan, entitlements and billing " +
      "currency. Pin this — every amount in every other response is in minor units of this " +
      "currency.",
    mimeType: "application/json",
    read: (ctx) => forwardRead("read_store", ctx),
  },
  {
    uri: "markii://sites",
    name: "sites",
    title: "Storefronts",
    description:
      "Every storefront in this organization, with slug, status and custom domain. The slugs " +
      "here are what the markii://site/{slug}/... resources take.",
    mimeType: "application/json",
    read: (ctx) => forwardRead("read_sites", ctx),
  },
  {
    uri: "markii://conventions",
    name: "conventions",
    title: "Operating rules",
    description:
      "How this server behaves: minor units, read before write, and which refusals are by " +
      "design. The same rules the prompts carry.",
    mimeType: "text/markdown",
    read: async () => CONVENTIONS,
  },
];

const SITE_DOCS = {
  "llms.txt": {
    mimeType: "text/plain",
    title: "Storefront llms.txt",
    description:
      "The store summary an AI agent reads at that storefront's own domain — byte for byte " +
      "what a shopper's agent sees. Read it to answer 'what do agents know about my store'.",
    render: (data: SiteData) => Promise.resolve(renderLlmsTxt(data)),
  },
  "agent.md": {
    mimeType: "text/markdown",
    title: "Storefront agent.md",
    description:
      "The agent protocol document that storefront publishes: how an agent buys, on which " +
      "rails, and to which payout address.",
    render: (data: SiteData) => renderAgentMd(data),
  },
} as const;

type SiteDocKind = keyof typeof SITE_DOCS;

const SITE_URI = /^markii:\/\/site\/([^/]+)\/(llms\.txt|agent\.md)$/;

export function resourceList(): McpResource[] {
  // `read` is an implementation detail; the fields below are the wire shape.
  return STATIC_RESOURCES.map((r) => ({
    uri: r.uri,
    name: r.name,
    title: r.title,
    description: r.description,
    mimeType: r.mimeType,
  }));
}

export function resourceTemplates(): McpResourceTemplate[] {
  return (Object.keys(SITE_DOCS) as SiteDocKind[]).map((kind) => ({
    uriTemplate: `markii://site/{slug}/${kind}`,
    name: `site_${kind.replace(".", "_")}`,
    title: SITE_DOCS[kind].title,
    description: SITE_DOCS[kind].description,
    mimeType: SITE_DOCS[kind].mimeType,
  }));
}

/**
 * Reads one resource.
 *
 * An unknown URI raises {@link ResourceNotFound}, which the route reports as the
 * MCP spec's own `-32002` rather than the `NOT_FOUND` an unknown *prompt* gets:
 * a client that special-cases that code can tell "no such resource" from "your
 * request was malformed", and it chose this URI off a list it was handed, so
 * there is no model in the loop to recover by choosing differently.
 */
export async function readResource(uri: string, ctx: ResourceCtx): Promise<ResourceContents[]> {
  const stat = STATIC_RESOURCES.find((r) => r.uri === uri);
  if (stat) {
    return [{ uri, mimeType: stat.mimeType, text: await stat.read(ctx) }];
  }

  const match = SITE_URI.exec(uri);
  if (match) {
    const [, slug, kind] = match;
    return [await readSiteDoc(decodeURIComponent(slug), kind as SiteDocKind, uri, ctx)];
  }

  throw new ResourceNotFound(uri);
}

async function readSiteDoc(
  slug: string,
  kind: SiteDocKind,
  uri: string,
  ctx: ResourceCtx,
): Promise<ResourceContents> {
  /**
   * **Org scope before anything else**, narrowed to the staff member's own
   * stores. `loadSite` resolves a slug *globally* — it is the storefront's
   * loader, called where a hostname has already decided the tenant — so reaching
   * for it first would let one org's token read another org's store by guessing
   * a slug. A miss is reported as a missing resource, never as a forbidden one,
   * so the answer cannot be used to discover whose slug exists.
   */
  const [own] = await db
    .select({ slug: sites.slug })
    .from(sites)
    .where(and(ownSitesForStaff(ctx.session.org.id, ctx.session.storeIds), eq(sites.slug, slug)))
    .limit(1);

  if (!own) throw new ResourceNotFound(uri);

  const data = await loadSite(own.slug);
  // A row that exists in `sites` and fails to load is a fault, not a 404.
  if (!data) throw new ApiError("INTERNAL", 500, `Storefront "${slug}" could not be loaded`);

  /**
   * **Refused with the reason rather than rendered anyway.** The storefront
   * route 404s in both of these cases, so handing the document over here would
   * show a merchant a page their store does not serve — the precise shape of
   * "never imply something happened when it didn't". Naming the cause is what
   * makes it actionable: one is a setting they can switch on, the other is their
   * own pause or a billing hold.
   */
  if (!data.site.agentDiscovery) {
    throw new ApiError(
      "CONFLICT",
      409,
      `Storefront "${slug}" has agent discovery turned off, so it publishes no ${kind} and ` +
        "agents visiting it get a 404. Turn agent discovery on for this site to publish one.",
    );
  }
  if (storefrontHalted(data)) {
    throw new ApiError(
      "CONFLICT",
      409,
      `Storefront "${slug}" is not serving — it is paused, or the account is not in good ` +
        `standing — so ${kind} returns a 404 to agents right now.`,
    );
  }

  return {
    uri,
    mimeType: SITE_DOCS[kind].mimeType,
    text: await SITE_DOCS[kind].render(data),
  };
}
