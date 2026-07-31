"use client";

import type { PreviewResponse, SitemapNode } from "@/lib/api/preview";
import { cn } from "@/lib/utils";

function SitemapTree({ nodes }: { nodes: SitemapNode[] }) {
  return (
    <ul className="space-y-2 text-sm">
      {nodes.map((node) => (
        <li key={`${node.path}-${node.title}`}>
          <div className="flex items-baseline gap-2">
            <span className="font-medium text-foreground">{node.title}</span>
            <span className="font-mono text-xs text-muted">{node.path}</span>
          </div>
          {node.children?.length ? (
            <div className="mt-2 border-l border-border pl-3">
              <SitemapTree nodes={node.children} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function PreviewPanes({
  preview,
  active,
  onTabChange,
  className,
}: {
  preview: PreviewResponse | null;
  active: "html" | "llms" | "agent" | "sitemap";
  onTabChange: (tab: "html" | "llms" | "agent" | "sitemap") => void;
  className?: string;
}) {
  const tabs = [
    { id: "html" as const, label: "HTML" },
    { id: "llms" as const, label: "llms.txt" },
    { id: "agent" as const, label: "agent.md" },
    { id: "sitemap" as const, label: "Sitemap" },
  ];

  return (
    <div
      className={cn(
        "flex min-h-[420px] flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface",
        className,
      )}
    >
      <div className="flex flex-wrap gap-1 border-b border-border p-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "cursor-pointer rounded-[var(--radius-control)] px-3 py-1.5 text-sm transition-colors",
              active === tab.id
                ? "bg-hover font-medium text-foreground hover:bg-hover"
                : "text-muted hover:bg-hover-soft hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 bg-background">
        {!preview ? (
          <p className="p-4 text-sm text-muted">
            Previews update as you edit the draft.
          </p>
        ) : active === "html" ? (
          <iframe
            title="Storefront HTML preview"
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={preview.html}
            className="h-full min-h-[380px] w-full border-0 bg-white"
          />
        ) : active === "llms" ? (
          <pre className="h-full overflow-auto p-4 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground">
            {preview.llmsTxt}
          </pre>
        ) : active === "agent" ? (
          <pre className="h-full overflow-auto p-4 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground">
            {preview.agentMd}
          </pre>
        ) : (
          <div className="overflow-auto p-4">
            <SitemapTree nodes={preview.sitemap?.pages ?? []} />
          </div>
        )}
      </div>
    </div>
  );
}
