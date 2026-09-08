CREATE TABLE "t12_net_sales" (
	"org_id" text NOT NULL,
	"product_class" text,
	"net_sales_minor" integer DEFAULT 0 NOT NULL,
	"unconverted_count" integer DEFAULT 0 NOT NULL,
	"unclassified_count" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "t12_net_sales" ADD CONSTRAINT "t12_net_sales_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "t12_net_sales_org_class_uq" ON "t12_net_sales" USING btree ("org_id",coalesce("product_class", ''));--> statement-breakpoint
CREATE INDEX "t12_net_sales_computed_idx" ON "t12_net_sales" USING btree ("computed_at");

-- Deny-by-default, per the standing rule that every table gets RLS even though
-- authorization lives in the action registry rather than in Postgres policies.
--
-- **No FORCE.** The app connects as the table owner, which RLS exempts, so this
-- closes the table to the anon/authenticated browser roles without touching the
-- server's own access. Forcing it with zero policies would make every
-- application query return zero rows — for this table that would mean the meter
-- silently falling back to the live sum forever, a cache that never hits and
-- never says so.
ALTER TABLE "t12_net_sales" ENABLE ROW LEVEL SECURITY;
