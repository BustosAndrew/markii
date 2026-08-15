-- Custom storefront domains become *verified* domains.
--
-- `sites.custom_domain` was free text with no uniqueness and no proof of
-- ownership, and `resolveCustomDomain` routes on it. Two problems followed from
-- that, and neither needed an attacker to be clever:
--
--   1. Any org could write another company's hostname into the column. The
--      moment that host pointed at Markii — a stale DNS record, a domain bought
--      after a lapse, or a merchant mid-migration — the squatter's storefront
--      answered for it.
--   2. Nothing stopped two sites holding the same hostname, and the resolver
--      takes `limit 1`. Whichever row the planner happened to return won, and
--      it could change between deployments.
--
-- Ownership is now proved by a DNS TXT record only the domain's controller can
-- publish, and only a `verified` row resolves.

ALTER TABLE "sites" ADD COLUMN "domain_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "domain_verification_token" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "domain_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "domain_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "domain_last_error" text;--> statement-breakpoint

-- Case and whitespace are not a routing boundary. The resolver lowercases the
-- Host header before comparing, so a row stored as `Shop.Example.com` never
-- matched anything and looked connected in the dashboard regardless.
UPDATE "sites" SET "custom_domain" = lower(btrim("custom_domain"))
  WHERE "custom_domain" IS NOT NULL;--> statement-breakpoint

-- Grandfather domains that are already routing, but only where the claim is
-- uncontested. A live storefront must not go dark because verification arrived;
-- a *contested* hostname has no honest winner, so both sides drop to `pending`
-- and whoever can publish the TXT record takes it.
UPDATE "sites" s
SET "domain_status" = 'verified',
    "domain_verified_at" = now(),
    "domain_verification_token" = md5(random()::text || clock_timestamp()::text)
WHERE s."custom_domain" IS NOT NULL
  AND (SELECT count(*) FROM "sites" o WHERE o."custom_domain" = s."custom_domain") = 1;--> statement-breakpoint

UPDATE "sites"
SET "domain_status" = 'pending',
    "domain_verification_token" = md5(random()::text || clock_timestamp()::text)
WHERE "custom_domain" IS NOT NULL AND "domain_status" = 'none';--> statement-breakpoint

-- The resolver's index. Every custom-domain request reads this column.
CREATE INDEX "sites_custom_domain_idx" ON "sites" USING btree ("custom_domain");--> statement-breakpoint

-- **One site may hold a verified domain.** Partial rather than global on purpose:
-- several orgs may have an unverified claim on the same hostname at once, which
-- is what stops a squatter from parking a claim to lock the real owner out. Only
-- proof is exclusive.
CREATE UNIQUE INDEX "sites_custom_domain_verified_uq" ON "sites" USING btree ("custom_domain") WHERE "sites"."domain_status" = 'verified';--> statement-breakpoint

-- The two facts must move together: a domain with no status is not connected,
-- and a status with no domain has nothing to verify. Valid for existing rows by
-- construction — the backfill above just made it so.
ALTER TABLE "sites" ADD CONSTRAINT "sites_domain_status_coherent"
  CHECK (("custom_domain" IS NULL) = ("domain_status" = 'none'));--> statement-breakpoint

ALTER TABLE "sites" ADD CONSTRAINT "sites_domain_status_values"
  CHECK ("domain_status" IN ('none', 'pending', 'verified'));--> statement-breakpoint

-- `verified_at` answers "since when?", so a verified row without one cannot.
ALTER TABLE "sites" ADD CONSTRAINT "sites_domain_verified_has_time"
  CHECK ("domain_status" <> 'verified' OR "domain_verified_at" IS NOT NULL);--> statement-breakpoint

-- A hostname, not a URL and not a trailing-dot FQDN — the same shape
-- `email_identities` enforces, for the same reason: the failure otherwise
-- surfaces much later as a verification that simply never completes.
--
-- **NOT VALID**: new and updated rows are checked, existing ones are left alone.
-- A single malformed legacy row would otherwise fail the whole deploy, and
-- silently nulling it would take a merchant's storefront off its domain without
-- telling anyone.
ALTER TABLE "sites" ADD CONSTRAINT "sites_custom_domain_shape"
  CHECK ("custom_domain" IS NULL OR "custom_domain" ~
    '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$') NOT VALID;
