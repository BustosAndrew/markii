import type { Metadata } from "next";
import { ContactForm } from "@/components/marketing/contact-form";

export const metadata: Metadata = {
  title: "Contact — Markii",
  description: "Get in touch with Markii at support@markii.shop.",
};

export default function ContactPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-14 pb-20">
      <div className="grid gap-12 lg:grid-cols-[1fr_1.15fr] lg:items-start">
        <div>
          <p className="text-sm font-medium text-brand">Contact</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-[-0.04em] text-balance text-foreground sm:text-5xl">
            Say hello
          </h1>
          <p className="mt-4 text-lg leading-8 text-muted">
            Questions about the product, pricing, or your account. We read every
            message.
          </p>

          <dl className="mt-10 space-y-6 text-sm">
            <div>
              <dt className="font-medium text-foreground">Email</dt>
              <dd className="mt-1">
                <a
                  href="mailto:support@markii.shop"
                  className="text-muted transition-colors hover:text-brand"
                >
                  support@markii.shop
                </a>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-foreground">How fast we reply</dt>
              <dd className="mt-1 leading-6 text-muted">
                Broken checkouts come first, no matter which plan you are on.
                Typical first reply: within 2 business days on Starter, 1 on
                Growth, and 8 business hours on Scale.
              </dd>
            </div>
          </dl>
        </div>

        <ContactForm />
      </div>
    </div>
  );
}
