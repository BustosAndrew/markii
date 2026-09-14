-- Dunning (D10): what happens between a failed renewal and a lost merchant.
--
-- `organizations.past_due_since` marks when the current episode began. It is a
-- timestamp and deliberately not a step: the step — grace, restricted growth,
-- restricted writes, suspended — is derived from it and the clock on every
-- request (`lib/billing/dunning.ts`), so it moves at the right second whether or
-- not any job ran. Written on the transition into `past_due`, kept through
-- `unpaid` (Stripe giving up does not restart the clock), cleared by any status
-- that grants a plan or by a cancellation.
--
-- `dunning_notices` records which of the three emails (day 0, 7, 13) has gone
-- out for which episode, claimed before the send so the daily sweep cannot mail
-- the same merchant twice for one step. Keyed on the episode start rather than
-- the org alone, so a second failed card next year gets the sequence again.

CREATE TABLE "dunning_notices" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"past_due_since" timestamp with time zone NOT NULL,
	"step" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "past_due_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dunning_notices" ADD CONSTRAINT "dunning_notices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dunning_notices_episode_step_uq" ON "dunning_notices" USING btree ("org_id","past_due_since","step");--> statement-breakpoint

-- Deny-by-default, per the standing rule that every table gets RLS even though
-- authorization lives in the action registry. No FORCE: the app connects as the
-- table owner, which RLS exempts.
ALTER TABLE "dunning_notices" ENABLE ROW LEVEL SECURITY;
