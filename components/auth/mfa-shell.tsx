import { Logo } from "@/components/logo";

export function MfaShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center px-6 py-12">
      <div className="w-full rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-[var(--shadow-sm)]">
        <div className="mb-6 flex items-center gap-3">
          <Logo size={32} />
          <div>
            <p className="text-base font-semibold tracking-tight text-foreground">
              markii
            </p>
            <p className="text-sm text-muted">Two-factor authentication</p>
          </div>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted">{description}</p>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}
