"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { invokeAction } from "@/lib/api/actions";
import { currencyExponent, formatMinor } from "@/lib/api/money";
import type { OrderDetail } from "@/lib/api/orders";
import { ApiClientError } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label, Select, Textarea } from "@/components/ui/field";
import { Toggle } from "@/components/ui/toggle";

type ActionKind = "refund" | "fulfill" | "cancel" | "note";

const REFUND_REASONS = [
  { value: "requested_by_customer", label: "Requested by customer" },
  { value: "duplicate", label: "Duplicate" },
  { value: "fraudulent", label: "Fraudulent" },
  { value: "item_unavailable", label: "Item unavailable" },
  { value: "other", label: "Other" },
] as const;

function parseMinorInput(value: string, currency: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  const exponent = currencyExponent(currency);
  return Math.round(n * 10 ** exponent);
}

export function OrderActions({ order }: { order: OrderDetail }) {
  const router = useRouter();
  const currency = order.totals.currency;
  const isX402 = order.provider === "x402";

  const canRefund =
    order.status === "success" &&
    order.cancelledAt == null &&
    order.totals.refundableMinor > 0;
  const canCancel =
    order.financialStatus === "pending" && order.cancelledAt == null;
  const canFulfill =
    order.itemised &&
    order.cancelledAt == null &&
    order.fulfillmentStatus !== "not_required" &&
    order.lines.some((line) => line.quantityUnfulfilled > 0);

  const available = useMemo(() => {
    const actions: ActionKind[] = ["note"];
    if (canRefund) actions.unshift("refund");
    if (canFulfill) actions.unshift("fulfill");
    if (canCancel) actions.unshift("cancel");
    return actions;
  }, [canRefund, canFulfill, canCancel]);

  const [action, setAction] = useState<ActionKind>(available[0] ?? "note");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Refund state
  const [refundReason, setRefundReason] =
    useState<(typeof REFUND_REASONS)[number]["value"]>("requested_by_customer");
  const [refundMethod, setRefundMethod] = useState<"manual" | "processor">(
    isX402 ? "manual" : "manual",
  );
  const [refundNote, setRefundNote] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [lineQty, setLineQty] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      order.lines.map((line) => [line.id, line.quantityRefundable > 0 ? "0" : ""]),
    ),
  );
  const [refundNotify, setRefundNotify] = useState(false);

  // Fulfill state
  const [fulfillQty, setFulfillQty] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      order.lines.map((line) => [
        line.id,
        line.quantityUnfulfilled > 0 ? String(line.quantityUnfulfilled) : "0",
      ]),
    ),
  );
  const [trackingNumber, setTrackingNumber] = useState("");
  const [carrier, setCarrier] = useState("");
  const [fulfillNotify, setFulfillNotify] = useState(true);

  // Cancel state
  const [cancelReason, setCancelReason] = useState("");
  const [cancelRestock, setCancelRestock] = useState(true);
  const [cancelNotify, setCancelNotify] = useState(false);

  // Note state
  const [noteText, setNoteText] = useState("");
  const [noteVisibility, setNoteVisibility] = useState<"internal" | "customer">(
    "internal",
  );

  function resetError() {
    setError(null);
  }

  async function runRefund() {
    const body: Record<string, unknown> = {
      orderId: order.id,
      reason: refundReason,
      method: isX402 ? "manual" : refundMethod,
      notifyCustomer: refundNotify,
    };
    if (refundNote.trim()) body.note = refundNote.trim();

    if (order.itemised) {
      const lines = order.lines
        .map((line) => ({
          orderLineId: line.id,
          quantity: Number(lineQty[line.id] ?? 0),
        }))
        .filter((line) => line.quantity > 0);
      if (lines.length === 0) {
        setError("Enter a quantity to refund on at least one line.");
        return;
      }
      body.lines = lines;
    } else {
      const amountMinor = parseMinorInput(refundAmount, currency);
      if (amountMinor == null) {
        setError("Enter a valid refund amount.");
        return;
      }
      if (amountMinor > order.totals.refundableMinor) {
        setError(
          `Amount exceeds ${formatMinor(order.totals.refundableMinor, currency)} still refundable.`,
        );
        return;
      }
      body.amountMinor = amountMinor;
    }

    setBusy(true);
    try {
      const outcome = await invokeAction("orders.refund", body);
      if (!outcome.ok) {
        setError("Refund could not be recorded.");
        return;
      }
      setConfirmOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Refund failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runFulfill() {
    const lines = order.lines
      .map((line) => ({
        orderLineId: line.id,
        quantity: Number(fulfillQty[line.id] ?? 0),
      }))
      .filter((line) => line.quantity > 0);

    if (lines.length === 0) {
      setError("Enter a quantity to ship on at least one line.");
      return;
    }

    for (const line of lines) {
      const source = order.lines.find((l) => l.id === line.orderLineId);
      if (source && line.quantity > source.quantityUnfulfilled) {
        setError(`Line "${source.title}" has only ${source.quantityUnfulfilled} left to ship.`);
        return;
      }
    }

    setBusy(true);
    try {
      const outcome = await invokeAction("orders.fulfill", {
        orderId: order.id,
        lines,
        trackingNumber: trackingNumber.trim() || null,
        carrier: carrier.trim() || null,
        notifyCustomer: fulfillNotify,
      });
      if (!outcome.ok) {
        setError("Fulfillment could not be recorded.");
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Fulfillment failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runCancel() {
    if (!cancelReason.trim()) {
      setError("A cancellation reason is required.");
      return;
    }

    setBusy(true);
    try {
      const outcome = await invokeAction("orders.cancel", {
        orderId: order.id,
        reason: cancelReason.trim(),
        restock: cancelRestock,
        notifyCustomer: cancelNotify,
      });
      if (!outcome.ok) {
        setError("Order could not be cancelled.");
        return;
      }
      setConfirmOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Cancellation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runNote() {
    if (!noteText.trim()) {
      setError("Note text is required.");
      return;
    }

    setBusy(true);
    try {
      const outcome = await invokeAction("orders.addNote", {
        orderId: order.id,
        note: noteText.trim(),
        visibility: noteVisibility,
      });
      if (!outcome.ok) {
        setError("Note could not be added.");
        return;
      }
      setNoteText("");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not add note.");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    resetError();
    if (action === "refund" || action === "cancel") {
      setConfirmOpen(true);
      return;
    }
    if (action === "fulfill") void runFulfill();
    if (action === "note") void runNote();
  }

  if (available.length === 0) {
    return (
      <p className="text-sm text-muted">
        No actions are available for this order in its current state.
      </p>
    );
  }

  return (
    <>
      <form onSubmit={onSubmit} className="space-y-4">
        {available.length > 1 ? (
          <div>
            <Label htmlFor="order-action">Action</Label>
            <Select
              id="order-action"
              value={action}
              onChange={(e) => {
                setAction(e.target.value as ActionKind);
                resetError();
              }}
            >
              {canCancel ? <option value="cancel">Cancel order</option> : null}
              {canRefund ? <option value="refund">Refund</option> : null}
              {canFulfill ? <option value="fulfill">Mark shipped</option> : null}
              <option value="note">Add note</option>
            </Select>
          </div>
        ) : null}

        {action === "refund" ? (
          <>
            <div>
              <Label htmlFor="refund-reason">Reason</Label>
              <Select
                id="refund-reason"
                value={refundReason}
                onChange={(e) =>
                  setRefundReason(e.target.value as typeof refundReason)
                }
              >
                {REFUND_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </div>

            {!isX402 ? (
              <div>
                <Label htmlFor="refund-method">Method</Label>
                <Select
                  id="refund-method"
                  value={refundMethod}
                  onChange={(e) =>
                    setRefundMethod(e.target.value as "manual" | "processor")
                  }
                >
                  <option value="manual">Manual — I returned the money</option>
                  <option value="processor">Processor — issue on card rail</option>
                </Select>
              </div>
            ) : (
              <p className="text-xs text-muted">
                x402 settlements are final. Refunds are recorded as manual — you
                must return USDC yourself.
              </p>
            )}

            {order.itemised ? (
              <div className="space-y-2">
                <Label>Lines to refund</Label>
                {order.lines
                  .filter((line) => line.quantityRefundable > 0)
                  .map((line) => (
                    <div
                      key={line.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border px-3 py-2"
                    >
                      <div className="min-w-0 text-sm">
                        <div className="font-medium text-foreground">{line.title}</div>
                        <div className="text-xs text-muted">
                          Up to {line.quantityRefundable} refundable
                        </div>
                      </div>
                      <Input
                        type="number"
                        min={0}
                        max={line.quantityRefundable}
                        className="w-20"
                        value={lineQty[line.id] ?? "0"}
                        onChange={(e) =>
                          setLineQty((prev) => ({
                            ...prev,
                            [line.id]: e.target.value,
                          }))
                        }
                      />
                    </div>
                  ))}
              </div>
            ) : (
              <div>
                <Label htmlFor="refund-amount">
                  Amount ({formatMinor(order.totals.refundableMinor, currency)} max)
                </Label>
                <Input
                  id="refund-amount"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                />
              </div>
            )}

            <div>
              <Label htmlFor="refund-note">Note (optional)</Label>
              <Textarea
                id="refund-note"
                rows={2}
                value={refundNote}
                onChange={(e) => setRefundNote(e.target.value)}
              />
            </div>

            <div className="rounded-[var(--radius-card)] border border-border bg-surface px-5">
              <Toggle
                label="Notify customer"
                description="Send a refund notice if mail is configured."
                checked={refundNotify}
                onChange={setRefundNotify}
                disabled={busy}
              />
            </div>
          </>
        ) : null}

        {action === "fulfill" ? (
          <>
            <div className="space-y-2">
              <Label>Units to ship</Label>
              {order.lines
                .filter((line) => line.quantityUnfulfilled > 0)
                .map((line) => (
                  <div
                    key={line.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border px-3 py-2"
                  >
                    <div className="min-w-0 text-sm">
                      <div className="font-medium text-foreground">{line.title}</div>
                      <div className="text-xs text-muted">
                        {line.quantityUnfulfilled} unfulfilled
                      </div>
                    </div>
                    <Input
                      type="number"
                      min={0}
                      max={line.quantityUnfulfilled}
                      className="w-20"
                      value={fulfillQty[line.id] ?? "0"}
                      onChange={(e) =>
                        setFulfillQty((prev) => ({
                          ...prev,
                          [line.id]: e.target.value,
                        }))
                      }
                    />
                  </div>
                ))}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="tracking">Tracking number</Label>
                <Input
                  id="tracking"
                  value={trackingNumber}
                  onChange={(e) => setTrackingNumber(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="carrier">Carrier</Label>
                <Input
                  id="carrier"
                  value={carrier}
                  onChange={(e) => setCarrier(e.target.value)}
                  placeholder="USPS, UPS, …"
                />
              </div>
            </div>

            <div className="rounded-[var(--radius-card)] border border-border bg-surface px-5">
              <Toggle
                label="Notify customer"
                description="Send a shipping notice if mail is configured."
                checked={fulfillNotify}
                onChange={setFulfillNotify}
                disabled={busy}
              />
            </div>
          </>
        ) : null}

        {action === "cancel" ? (
          <>
            <div>
              <Label htmlFor="cancel-reason">Reason</Label>
              <Textarea
                id="cancel-reason"
                rows={2}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                required
              />
            </div>

            <div className="rounded-[var(--radius-card)] border border-border bg-surface px-5">
              <Toggle
                label="Restock inventory"
                checked={cancelRestock}
                onChange={setCancelRestock}
                disabled={busy}
              />
              <Toggle
                label="Notify customer"
                checked={cancelNotify}
                onChange={setCancelNotify}
                disabled={busy}
              />
            </div>
          </>
        ) : null}

        {action === "note" ? (
          <>
            <div>
              <Label htmlFor="note-text">Note</Label>
              <Textarea
                id="note-text"
                rows={3}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="note-visibility">Visibility</Label>
              <Select
                id="note-visibility"
                value={noteVisibility}
                onChange={(e) =>
                  setNoteVisibility(e.target.value as "internal" | "customer")
                }
              >
                <option value="internal">Internal — staff only</option>
                <option value="customer">Customer — shown to buyer</option>
              </Select>
            </div>
          </>
        ) : null}

        <FieldError>{error}</FieldError>

        <Button type="submit" disabled={busy} className="w-full">
          {busy
            ? "Working…"
            : action === "refund"
              ? "Review refund"
              : action === "cancel"
                ? "Review cancellation"
                : action === "fulfill"
                  ? "Mark shipped"
                  : "Add note"}
        </Button>
      </form>

      <ConfirmDialog
        open={confirmOpen && action === "refund"}
        title="Issue this refund?"
        description={
          isX402
            ? "This records the refund in Markii. You must return USDC to the buyer yourself — x402 settlements cannot be reversed."
            : refundMethod === "processor"
              ? "Markii will issue this refund on the card rail from your Stripe balance."
              : "This records a refund you have already sent. Markii does not move the money."
        }
        confirmLabel="Issue refund"
        danger
        busy={busy}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void runRefund()}
      />

      <ConfirmDialog
        open={confirmOpen && action === "cancel"}
        title="Cancel this order?"
        description="This releases reserved stock and voids the order. It only applies to unpaid orders."
        confirmLabel="Cancel order"
        danger
        busy={busy}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void runCancel()}
      />
    </>
  );
}
