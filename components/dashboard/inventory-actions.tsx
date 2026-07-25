"use client";

import { useState } from "react";
import type { Site } from "@/lib/api/types";
import { Button, ButtonLink } from "@/components/ui/button";
import { ImportDialog } from "@/components/dashboard/import-dialog";

export function InventoryActions({ sites }: { sites: Site[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Import CSV / scrape
      </Button>
      <ButtonLink href="/dashboard/products/new">New product</ButtonLink>
      <ImportDialog open={open} onClose={() => setOpen(false)} sites={sites} />
    </>
  );
}
