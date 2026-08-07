-- Remove any merchant Stripe secret key ever stored by the old
-- `PUT /api/integrations/stripe`, which accepted `sk_…` and wrote it into
-- `integrations.config` as plaintext jsonb.
--
-- That contradicted D4 and docs/API.md §8 ("never a merchant secret key"), and a
-- live `sk_` grants full control of a merchant's account — charges, refunds,
-- payouts, customer PII, deletion. Connect Standard needs only a revocable
-- connection and an `acct_` id, so the key has no reason to exist here.
--
-- The row is kept and marked `not_connected` rather than deleted: the merchant
-- must reconnect through OAuth, and silently leaving `status = 'connected'`
-- would claim a working card rail backed by a credential we just removed.
UPDATE "integrations"
SET "config" = "config" - 'secretKey',
    "status" = 'not_connected',
    "message" = 'Reconnect Stripe: Markii no longer stores merchant secret keys (Connect Standard, D4).',
    "updated_at" = now()
WHERE "provider" = 'stripe' AND "config" ? 'secretKey';
