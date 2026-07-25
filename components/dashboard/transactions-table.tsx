"use client";

import { useState } from "react";
import type { Order } from "@/lib/api/types";
import { formatCents } from "@/lib/api/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const statusVariant = {
  success: "success",
  pending: "warning",
  cancel: "neutral",
  failed: "error",
} as const;

export function TransactionsTable({ orders }: { orders: Order[] }) {
  const [selected, setSelected] = useState<Order | null>(null);

  return (
    <>
      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
        <table className="w-full min-w-[800px] text-left text-sm">
          <thead className="bg-surface-elevated text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Product</th>
              <th className="px-4 py-3 font-medium">Amount</th>
              <th className="px-4 py-3 font-medium">Provider</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Agent</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr
                key={order.id}
                className="border-t border-border hover:bg-table-hover"
              >
                <td className="px-4 py-3 text-muted">
                  {new Date(order.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-3">
                  <p className="font-medium text-foreground">
                    {order.product?.name ?? "—"}
                  </p>
                  <p className="text-xs text-muted">×{order.quantity}</p>
                </td>
                <td className="px-4 py-3 tabular-nums">
                  {formatCents(order.amountCents, order.currency)}
                </td>
                <td className="px-4 py-3 text-muted">{order.provider}</td>
                <td className="px-4 py-3">
                  <Badge variant={statusVariant[order.status]}>
                    {order.status}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  <Button
                    variant="ghost"
                    className="px-2 py-1"
                    onClick={() => setSelected(order)}
                  >
                    {order.agent?.name ?? "Agent"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-foreground/20"
            aria-label="Close"
            onClick={() => setSelected(null)}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-md rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-[var(--shadow-md)]"
          >
            <h2 className="text-lg font-semibold text-foreground">
              Agent purchase
            </h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="text-muted">Agent</dt>
                <dd className="font-medium text-foreground">
                  {selected.agent.name}
                </dd>
              </div>
              <div>
                <dt className="text-muted">User-Agent</dt>
                <dd className="break-all font-mono text-xs text-foreground">
                  {selected.agent.userAgent}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Wallet</dt>
                <dd className="break-all font-mono text-xs text-foreground">
                  {selected.agent.walletAddress ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Tx hash</dt>
                <dd className="break-all font-mono text-xs text-foreground">
                  {selected.txHash ?? "—"}
                </dd>
              </div>
            </dl>
            <div className="mt-6 flex justify-end">
              <Button variant="secondary" onClick={() => setSelected(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
