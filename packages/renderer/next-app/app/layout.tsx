import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getStore, siteUrl } from "../lib/markii";

export async function generateMetadata(): Promise<Metadata> {
  const store = await getStore();
  const base = siteUrl();
  return {
    title: store?.store.name ?? "Store",
    ...(base ? { metadataBase: new URL(base) } : {}),
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
