"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase/client";

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
    description: "Supabase Auth will power merchant sign-up once the environment is configured.",
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const content = useMemo(() => copy[mode], [mode]);
  const configured = isSupabaseConfigured();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setError("Configuration required: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
      return;
    }

    setPending(true);
    try {
      if (mode === "sign-in") {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (signInError) {
          setError(signInError.message);
        } else {
          setMessage("Signed in. Refresh the dashboard once protected routes are wired.");
        }
      } else if (mode === "sign-up") {
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
        });

        if (signUpError) {
          setError(signUpError.message);
        } else {
          setMessage("Account created. Check your inbox if email confirmation is enabled.");
        }
      } else {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/sign-in`,
        });

        if (resetError) {
          setError(resetError.message);
        } else {
          setMessage("Password reset email requested.");
        }
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

        {!configured ? (
          <div className="mt-6 rounded-[var(--radius-control)] border border-border bg-surface-elevated p-4 text-sm leading-6 text-muted">
            Configuration required. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
            to enable merchant auth.
          </div>
        ) : null}

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
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
                type="password"
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
          ) : null}

          {error ? <p className="text-sm text-error-text">{error}</p> : null}
          {message ? <p className="text-sm text-success-text">{message}</p> : null}

          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Working..." : content.submitLabel}
          </Button>
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
