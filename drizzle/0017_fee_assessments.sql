CREATE TABLE "fee_assessments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"plan_id" text NOT NULL,
	"threshold_minor" integer NOT NULL,
	"overage_rate_bps" integer NOT NULL,
	"t12_net_sales_minor" integer NOT NULL,
	"period_net_sales_minor" integer NOT NULL,
	"billable_minor" integer NOT NULL,
	"fee_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"workings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"invoiced" boolean DEFAULT false NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fee_assessments" ADD CONSTRAINT "fee_assessments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_assessments_period_uq" ON "fee_assessments" USING btree ("org_id","period_start");--> statement-breakpoint
CREATE INDEX "fee_assessments_org_idx" ON "fee_assessments" USING btree ("org_id","period_start");--> statement-breakpoint

-- Money discipline at the database. A negative fee is a credit, which §4.4 says
-- belongs on the *next* period as its own line — never as a negative assessment
-- silently netted against this one.
ALTER TABLE "fee_assessments" ADD CONSTRAINT "fee_assessments_fee_non_negative" CHECK ("fee_minor" >= 0);--> statement-breakpoint
ALTER TABLE "fee_assessments" ADD CONSTRAINT "fee_assessments_billable_non_negative" CHECK ("billable_minor" >= 0);--> statement-breakpoint
-- A period that ends before it starts would produce a nonsense trailing window.
ALTER TABLE "fee_assessments" ADD CONSTRAINT "fee_assessments_period_ordered" CHECK ("period_start" < "period_end");--> statement-breakpoint

-- Deny by default (D6).
ALTER TABLE "fee_assessments" ENABLE ROW LEVEL SECURITY;
