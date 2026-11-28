"use client";

import { Label, Select } from "@/components/ui/field";

export type AccessTier = { id: number; name: string };

export function WhoCanReadSelect({
  id,
  value,
  tiers,
  disabled,
  onChange,
  hint,
}: {
  id: string;
  value: number | null;
  tiers: AccessTier[];
  disabled?: boolean;
  onChange: (tierId: number | null) => void;
  hint?: string;
}) {
  const known = value != null && tiers.some((t) => t.id === value);
  return (
    <div>
      <Label htmlFor={id}>Who can read this</Label>
      <Select
        id={id}
        value={known ? String(value) : ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">Everyone</option>
        {tiers.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
