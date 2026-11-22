import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StoreFooter, StoreTop } from "@/components/storefront/store-chrome";
import { ThemeRoot } from "@/components/storefront/theme-root";
import { formByHandle } from "@/lib/forms/submit";
import { loadSite, storefrontHalted } from "@/lib/storefront";
import { redirectOrNotFound } from "@/lib/storefront/redirects";
import { FormView } from "@markii/renderer/forms-view";

type Props = {
  params: Promise<{ site: string; handle: string }>;
  searchParams: Promise<{ status?: string; field?: string; from?: string }>;
};

/**
 * `/forms/{handle}` — a store's form on a page of its own, and where a plain
 * form post lands afterwards (`?status=` from `/api/forms/{handle}`). Every
 * state is said in words: sent, too many, a field to fix, or refused without
 * saying why. Server-rendered, no island. Never indexed — a form is not content.
 */

function safeFrom(raw: string | undefined): string | null {
  return raw && /^\/(?!\/)[^\s]{0,300}$/.test(raw) ? raw : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site: siteSlug, handle } = await params;
  const data = await loadSite(siteSlug);
  if (!data) return {};
  const form = await formByHandle(data.site.id, handle);
  return form ? { title: `${form.name} — ${data.site.name}`, robots: { index: false } } : {};
}

export default async function FormPage({ params, searchParams }: Props) {
  const { site: siteSlug, handle } = await params;
  const data = await loadSite(siteSlug);
  if (!data || storefrontHalted(data)) notFound();
  const form = await formByHandle(data.site.id, handle);
  if (!form) return redirectOrNotFound(data, `/forms/${handle}`);

  const { status, field, from } = await searchParams;
  const base = data.baseUrl.replace(/\/$/, "");
  const back = safeFrom(from);
  const label = form.fields.find((f) => f.name === field)?.label;
  const notice =
    status === "limited"
      ? "Too many messages have been sent from here. Please try again in a little while."
      : status === "invalid"
        ? label
          ? `Please check “${label}” and send again.`
          : "Please check the form and send again."
        : status === "refused"
          ? "This message could not be sent."
          : null;

  return (
    <ThemeRoot themeId={data.site.themeId ?? "studio"} theme={data.theme} preview={data.preview}>
      <StoreTop data={data} />
      <main className="sf-main">
        <p className="sf-crumb">
          <a href={`${base}/`}>{data.site.name}</a> / {form.name}
        </p>
        <header className="sf-hero">
          <h1 className="sf-title">{form.name}</h1>
        </header>
        {status === "sent" ? (
          <section className="sf-form-result" role="status">
            <p className="sf-lede">{form.successMessage.trim() || "Thank you — your message has been sent."}</p>
            <p>
              <a href={`${base}${back ?? "/"}`}>{back ? "← Back" : "← Back to the store"}</a>
            </p>
          </section>
        ) : (
          <>
            {notice ? (
              <p className="sf-form-notice" role="alert">
                {notice}
              </p>
            ) : null}
            <FormView
              form={{ handle: form.handle, name: form.name, fields: form.fields, submitLabel: form.submitLabel }}
              action={`${base}/api/forms/${form.handle}`}
              returnPath={back ?? undefined}
            />
          </>
        )}
      </main>
      <StoreFooter data={data} />
    </ThemeRoot>
  );
}
