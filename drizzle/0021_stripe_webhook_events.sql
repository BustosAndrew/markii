CREATE TABLE "stripe_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"stripe_account" text,
	"livemode" boolean NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"detail" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "stripe_webhook_events_type_idx" ON "stripe_webhook_events" USING btree ("type","received_at");--> statement-breakpoint
CREATE INDEX "stripe_webhook_events_account_idx" ON "stripe_webhook_events" USING btree ("stripe_account");--> statement-breakpoint

-- A terminal status without a finish time cannot answer "when did this settle?",
-- which is the first question asked when a merchant's billing looks wrong.
ALTER TABLE "stripe_webhook_events" ADD CONSTRAINT "stripe_webhook_events_settled_has_time"
  CHECK ("status" = 'received' OR "processed_at" IS NOT NULL);--> statement-breakpoint

-- An event that was not processed must say why. `ignored` and `failed` are
-- decisions, and a decision with no reason recorded is indistinguishable from a
-- handler that silently did nothing.
ALTER TABLE "stripe_webhook_events" ADD CONSTRAINT "stripe_webhook_events_unhandled_has_detail"
  CHECK ("status" NOT IN ('ignored', 'failed') OR "detail" IS NOT NULL);--> statement-breakpoint

-- Deny by default (D6). Nothing here is merchant-readable: it is Stripe's
-- delivery record, and the anon role must not see another org's billing events.
ALTER TABLE "stripe_webhook_events" ENABLE ROW LEVEL SECURITY;