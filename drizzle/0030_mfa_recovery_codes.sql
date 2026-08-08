-- MFA recovery codes (D40).
--
-- **Supabase ships TOTP and no backup codes.** D40 makes MFA mandatory for every
-- merchant at every sign-in, which turns "lost phone" from an unlucky edge case
-- into a guaranteed one at some volume — and without this table the only way
-- back is a hand-run service-role reset by whoever holds the keys. That is not a
-- recovery path, it is a support queue with a merchant's livelihood in it.
--
-- Keyed by `auth.users.id` rather than by staff membership: a person in three
-- organizations has one set of factors and one set of codes. Scoping per-org
-- would mint three sets, and using the wrong org's would be indistinguishable
-- from a forged code. No foreign key, matching `staff.user_id` — the `auth`
-- schema is owned by `supabase_auth_admin` and coupling the migration chain to
-- it is a bad trade.
CREATE TABLE "mfa_recovery_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	-- scrypt(code, salt). **Never the code.** A recovery code is a bearer
	-- credential equivalent to the second factor, so storing them recoverably
	-- would mean a database leak hands over every account MFA was protecting.
	"code_hash" text NOT NULL,
	"salt" text NOT NULL,
	-- Single use. Consumed rather than deleted, because "a code was used, at this
	-- time" is the first thing anyone asks when an account is accessed
	-- unexpectedly — and a deleted row cannot answer it.
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mfa_recovery_codes_user_idx" ON "mfa_recovery_codes" USING btree ("user_id");--> statement-breakpoint

-- Regenerating replaces the whole set, so one hash appears at most once per
-- user. Also stops a duplicate insert from creating two rows that a single code
-- would satisfy twice.
CREATE UNIQUE INDEX "mfa_recovery_codes_hash_uq" ON "mfa_recovery_codes" USING btree ("user_id","code_hash");--> statement-breakpoint

-- Deny by default (D6). Nothing here is ever readable by the browser role: these
-- are authentication secrets, and the anon role must not be able to enumerate
-- which accounts have unused recovery codes left.
ALTER TABLE "mfa_recovery_codes" ENABLE ROW LEVEL SECURITY;
