"use client";

import { useState } from "react";
import { sendContactMessage } from "@/lib/api/contact";
import { ApiClientError } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label, Select, Textarea } from "@/components/ui/field";

export function ContactForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [topic, setTopic] = useState("general");
  const [message, setMessage] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendContactMessage({
        name,
        email,
        topic: topic as "general" | "sales" | "support" | "billing",
        message,
        company,
      });
      setSent(true);
      setName("");
      setEmail("");
      setTopic("general");
      setMessage("");
      setCompany("");
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Something went wrong. Try again, or email support@markii.shop.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="rounded-[var(--radius-card)] border border-border bg-surface p-8">
        <p className="text-lg font-semibold tracking-tight text-foreground">
          Message sent
        </p>
        <p className="mt-2 text-sm leading-6 text-muted">
          Thanks. We will get back to you at the email you left. For something
          urgent, you can also write{" "}
          <a
            href="mailto:support@markii.shop"
            className="text-foreground underline-offset-2 hover:underline"
          >
            support@markii.shop
          </a>
          .
        </p>
        <Button
          type="button"
          variant="secondary"
          className="mt-6"
          onClick={() => setSent(false)}
        >
          Send another
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      className="relative rounded-[var(--radius-card)] border border-border bg-surface p-6 sm:p-8"
      noValidate
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <Label htmlFor="contact-name">Name</Label>
          <Input
            id="contact-name"
            name="name"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </div>
        <div>
          <Label htmlFor="contact-email">Email</Label>
          <Input
            id="contact-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        </div>
      </div>

      <div className="mt-5">
        <Label htmlFor="contact-topic">Topic</Label>
        <Select
          id="contact-topic"
          name="topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          disabled={busy}
        >
          <option value="general">General</option>
          <option value="sales">Sales</option>
          <option value="support">Support</option>
          <option value="billing">Billing</option>
        </Select>
      </div>

      <div className="mt-5">
        <Label htmlFor="contact-message">Message</Label>
        <Textarea
          id="contact-message"
          name="message"
          required
          rows={6}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={busy}
          placeholder="What can we help with?"
        />
      </div>

      {/* Honeypot — hidden from people, not from naive bots */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-[9999px] h-0 w-0 overflow-hidden opacity-0"
      >
        <Label htmlFor="contact-company">Company</Label>
        <Input
          id="contact-company"
          name="company"
          tabIndex={-1}
          autoComplete="off"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
      </div>

      <FieldError>{error}</FieldError>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send message"}
        </Button>
        <p className="text-xs text-muted">
          Or email{" "}
          <a
            href="mailto:support@markii.shop"
            className="text-foreground underline-offset-2 hover:underline"
          >
            support@markii.shop
          </a>
        </p>
      </div>
    </form>
  );
}
