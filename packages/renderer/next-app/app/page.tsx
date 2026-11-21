import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { defaultHomeTree } from "@markii/renderer/presets";
import { getStore } from "../lib/markii";
import { documentOf, seoOf, StorePage } from "../lib/page";

export async function generateMetadata(): Promise<Metadata> {
  const store = await getStore();
  if (!store) return {};
  const seo = seoOf(store, "page", "home");
  return { title: seo.title || store.store.name, description: seo.description || undefined, robots: seo.noindex ? { index: false } : undefined };
}

/** The published home page, or the renderer's default home when the store has none. */
export default async function Home() {
  const store = await getStore();
  if (!store) notFound();
  return <StorePage store={store} tree={documentOf(store, "page", "home") ?? defaultHomeTree(store.store)} />;
}
