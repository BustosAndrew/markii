import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none transition-shadow placeholder:text-muted-soft focus:border-brand focus:ring-4 focus:ring-brand/10 disabled:bg-hover disabled:text-disabled",
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none transition-shadow placeholder:text-muted-soft focus:border-brand focus:ring-4 focus:ring-brand/10 disabled:bg-hover disabled:text-disabled",
        className,
      )}
      {...props}
    />
  );
});

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "w-full cursor-pointer rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none transition-shadow focus:border-brand focus:ring-4 focus:ring-brand/10 disabled:cursor-not-allowed disabled:bg-hover disabled:text-disabled",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("mb-1.5 block text-sm font-medium text-foreground", className)}
      {...props}
    />
  );
}

export function FieldError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return <p className="mt-1.5 text-sm text-error-text">{children}</p>;
}
