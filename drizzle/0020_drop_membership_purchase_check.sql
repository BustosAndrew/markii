-- Drops `customer_memberships_purchase_has_order`, added one migration earlier.
--
-- The constraint said: a membership whose `source` is `purchase` must name the
-- order that paid for it. The intent was that a claim about a purchase should be
-- checkable, and that a refund should be able to find the membership it revokes.
--
-- It contradicts the foreign key it depends on. `order_id` is
-- `on delete set null` — deliberately, because an order record and the
-- entitlement it conferred have different lifetimes, and deleting an order must
-- not silently strip a membership someone paid for. But `set null` then leaves
-- the row violating this check, so Postgres refuses the delete outright: any
-- order that has ever granted a membership becomes undeletable, and it surfaces
-- as a constraint error nowhere near the cause.
--
-- Between the two, `set null` is the behaviour worth keeping. The weaker
-- invariant that remains — `source = 'purchase'` with a null `order_id` means
-- "an order paid for this and that order no longer exists" — is true and
-- readable, rather than impossible.
ALTER TABLE "customer_memberships"
  DROP CONSTRAINT IF EXISTS "customer_memberships_purchase_has_order";
