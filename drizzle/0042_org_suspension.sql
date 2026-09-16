-- Platform suspension (G12): a hold placed by Markii itself, not by billing.
--
-- `suspended_at` is a timestamp, not a status, for the same reason the trial
-- end and `past_due_since` are: `accountStanding` derives `suspended` from it
-- on every request, ahead of every billing state, so the store stops the second
-- it is set and nothing has to sweep. Written only by `platform.suspendOrg` and
-- cleared only by `platform.unsuspendOrg`, both operator-only actions. Paying
-- does not lift it — the merchant sees ACCOUNT_SUSPENDED and a support address,
-- never the subscribe button.
--
-- `suspended_by` is the operator's user id, on the row as well as in the audit
-- log: the audit view is the merchant's and is filterable; this is not.

ALTER TABLE "organizations" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspended_by" text;