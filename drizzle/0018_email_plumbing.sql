CREATE TABLE "email_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"template" text NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"provider_message_id" text,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"order_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"domain" text NOT NULL,
	"from_local_part" text DEFAULT 'orders' NOT NULL,
	"from_name" text,
	"reply_to" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"dkim_tokens" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"source_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_identities" ADD CONSTRAINT "email_identities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_deliveries_org_idx" ON "email_deliveries" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "email_deliveries_order_idx" ON "email_deliveries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "email_deliveries_message_idx" ON "email_deliveries" USING btree ("provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_identities_domain_uq" ON "email_identities" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "email_identities_org_idx" ON "email_identities" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppressions_uq" ON "email_suppressions" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "email_suppressions_org_idx" ON "email_suppressions" USING btree ("org_id");--> statement-breakpoint

-- Case is not a security boundary. A suppression list that `Bob@x.com` walks
-- past because it was stored as `bob@x.com` is not a suppression list, and the
-- same address verified twice under different case is two identities for one
-- mailbox. Lowercasing is enforced here as well as in the application, because
-- one path that forgets is all it takes.
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_email_lower"
  CHECK ("email" = lower("email"));--> statement-breakpoint
ALTER TABLE "email_identities" ADD CONSTRAINT "email_identities_domain_lower"
  CHECK ("domain" = lower("domain"));--> statement-breakpoint

-- A domain, not a URL and not a host with a trailing dot. SES rejects those, but
-- it rejects them *after* a merchant has waited for the verification round trip.
ALTER TABLE "email_identities" ADD CONSTRAINT "email_identities_domain_shape"
  CHECK ("domain" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$');--> statement-breakpoint

-- `verified_at` is the answer to "since when?", so a verified row without one is
-- a row that cannot answer it.
ALTER TABLE "email_identities" ADD CONSTRAINT "email_identities_verified_has_time"
  CHECK ("status" <> 'verified' OR "verified_at" IS NOT NULL);--> statement-breakpoint

-- A send that reports `sent` with no provider message id cannot be traced to a
-- bounce later, which is the whole reason this table exists.
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_sent_has_id"
  CHECK ("status" <> 'sent' OR "provider_message_id" IS NOT NULL);--> statement-breakpoint

-- Deny by default (D6).
ALTER TABLE "email_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_suppressions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_deliveries" ENABLE ROW LEVEL SECURITY;
