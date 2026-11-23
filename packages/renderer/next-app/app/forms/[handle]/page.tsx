import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FormView } from "@markii/renderer/forms-view";
import { getForm, getStore, siteUrl } from "../../../lib/markii";
import { formAction, StorePage } from "../../../lib/page";

type Props = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ status?: string; field?: string; from?: string }>;
};

/**
 * `/forms/{handle}` — a store form on a page of its own, as on Markii, and
 * where a post through `/api/forms/{handle}` lands with its outcome. Never
 * indexed: a form is not content.
 */

function safeFrom(raw: string | undefined): string | null {
  return raw && /^\/(?!\/)[^\s]{0,300}$/.test(raw) ? raw : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const form = await getForm((await params).handle);
  return form ? { title: form.name, robots: { index: false } } : {};
}

export default async function FormRoute({ params, searchParams }: Props) {
  const store = await getStore();
  const form = store ? await getForm((await params).handle) : null;
  if (!store || !form) notFound();

  const { status, field, from } = await searchParams;
  const base = siteUrl();
  const backTo = safeFrom(from);
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
          : status === "error"
            ? "This message could not be sent just now. Please try again."
            : null;

  return (
    <StorePage store={store}>
      <main className="sf-main">
        <p className="sf-crumb">
          <a href={`${base}/`}>{store.store.name}</a> / {form.name}
        </p>
        <header className="sf-hero">
          <h1 className="sf-title">{form.name}</h1>
        </header>
        {status === "sent" ? (
          <section className="sf-form-result" role="status">
            <p className="sf-lede">{form.successMessage.trim() || "Thank you — your message has been sent."}</p>
            <p>
              <a href={`${base}${backTo ?? "/"}`}>{backTo ? "← Back" : "← Back to the store"}</a>
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
              action={formAction(form.handle)}
              returnPath={backTo ?? undefined}
            />
          </>
        )}
      </main>
    </StorePage>
  );
}
