"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import {
  isAuthApiLive,
  requestPasswordReset,
  signIn,
  signUp,
} from "@/lib/api/auth";
import { isPlannedError } from "@/lib/api/planned";

type AuthMode = "sign-in" | "sign-up" | "reset-password";

const copy: Record<
  AuthMode,
  {
    title: string;
    description: string;
    submitLabel: string;
    secondary: { href: string; label: string };
  }
> = {
  "sign-in": {
    title: "Sign in",
    description: "Use your merchant account once Phase A auth is configured.",
    submitLabel: "Sign in",
    secondary: { href: "/sign-up", label: "Create account" },
  },
  "sign-up": {
    title: "Create account",
    description: "Merchant sign-up opens when Phase A auth is live.",
    submitLabel: "Create account",
    secondary: { href: "/sign-in", label: "Already have an account?" },
  },
  "reset-password": {
    title: "Reset password",
    description: "Request a password reset email for your merchant account.",
    submitLabel: "Send reset link",
    secondary: { href: "/sign-in", label: "Back to sign in" },
  },
};

export function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const content = useMemo(() => copy[mode], [mode]);
  const live = isAuthApiLive();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    setPending(true);

    try {
      // Every branch posts to Markii's own origin; the server sets the
      // httpOnly session cookie (D30). No Supabase call from the browser.
      if (mode === "sign-in") {
        await signIn({ email, password });
        router.replace("/dashboard");
        router.refresh();
      } else if (mode === "sign-up") {
        await signUp({ email, password });
        setMessage(
          "Account created. If email confirmation is enabled, check your inbox to finish.",
        );
      } else {
        await requestPasswordReset({ email });
        setMessage(
          "If an account exists for that address, a reset link is on its way.",
        );
      }
    } catch (caught) {
      if (isPlannedError(caught)) {
        setError(
          "Merchant auth is not live yet (API §16, Phase A). Nothing was submitted.",
        );
      } else if (caught instanceof Error) {
        setError(caught.message);
      } else {
        setError("Request failed. Try again.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center px-6 py-12">
      <div className="w-full rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-[var(--shadow-sm)]">
        <div className="mb-6 flex items-center gap-3">
          <Logo size={32} />
          <div>
            <p className="text-base font-semibold tracking-tight text-foreground">markii</p>
            <p className="text-sm text-muted">Merchant auth</p>
          </div>
        </div>

        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{content.title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted">{content.description}</p>

        {!live ? (
          <div className="mt-6 rounded-[var(--radius-control)] border border-border bg-surface-elevated p-4 text-sm leading-6 text-muted">
            <p>
              Merchant auth is planned, not live. Accounts, sessions, and password reset
              arrive with Phase A.
            </p>
            <span className="mt-3 inline-flex rounded-full bg-surface px-2.5 py-1 text-xs font-medium text-muted">
              API §16 · Accounts, organizations, staff
            </span>
          </div>
        ) : null}

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <fieldset disabled={!live || pending} className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>

            {mode !== "reset-password" ? (
              <div>
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </div>
            ) : null}

            <Button type="submit" className="w-full">
              {pending ? "Working..." : content.submitLabel}
            </Button>
          </fieldset>

          <p aria-live="polite" className="empty:hidden">
            {error ? <span className="text-sm text-error-text">{error}</span> : null}
            {message ? <span className="text-sm text-success-text">{message}</span> : null}
          </p>
        </form>

        <div className="mt-6 flex items-center justify-between gap-3 text-sm">
          <Link href={content.secondary.href} className="text-muted hover:text-foreground">
            {content.secondary.label}
          </Link>
          {mode !== "reset-password" ? (
            <Link href="/reset-password" className="text-muted hover:text-foreground">
              Forgot password?
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
