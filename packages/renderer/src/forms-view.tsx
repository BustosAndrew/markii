import { maxLengthOf, type FormField, type RenderForm } from "./forms";

/**
 * A storefront form as plain HTML. The browser enforces `required`, the email
 * format and every length before it posts; the server checks all of it again,
 * because a form post is the easiest request on the internet to forge.
 */

function Field({ field, id }: { field: FormField; id: string }) {
  const common = {
    id,
    name: field.name,
    required: field.required,
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
  };
  switch (field.type) {
    case "textarea":
      return <textarea {...common} rows={5} maxLength={maxLengthOf(field)} />;
    case "select":
      return (
        <select {...common} defaultValue="">
          <option value="" disabled={field.required}>
            {field.required ? "Choose…" : "—"}
          </option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "checkbox":
      return <input {...common} type="checkbox" value="yes" />;
    default:
      return (
        <input
          {...common}
          type={field.type}
          maxLength={maxLengthOf(field)}
          {...(field.type === "email" ? { autoComplete: "email" } : field.type === "tel" ? { autoComplete: "tel" } : {})}
        />
      );
  }
}

export function FormView({
  form,
  action,
  className,
  attrs,
  returnPath,
}: {
  form: RenderForm;
  /** The store's own `/api/forms/{handle}`, absolute. */
  action: string;
  className?: string;
  /** Extra attributes from the block (`data-mk-node` in the preview). */
  attrs?: Record<string, string>;
  /** The page the form sits on, so the result page can link back to it. Site-relative. */
  returnPath?: string;
}) {
  const prefix = `mk-form-${form.handle}`;
  return (
    <form method="post" action={action} className={["mk-form", className].filter(Boolean).join(" ")} {...attrs}>
      {form.fields.map((field) => {
        const id = `${prefix}-${field.name}`;
        return field.type === "checkbox" ? (
          <label key={field.name} className="mk-form-check" htmlFor={id}>
            <Field field={field} id={id} /> {field.label}
            {field.required ? <span aria-hidden="true"> *</span> : null}
          </label>
        ) : (
          <div key={field.name} className="mk-form-field">
            <label htmlFor={id}>
              {field.label}
              {field.required ? <span aria-hidden="true"> *</span> : null}
            </label>
            <Field field={field} id={id} />
          </div>
        );
      })}
      {returnPath ? <input type="hidden" name="_return" value={returnPath} /> : null}
      <button type="submit">{form.submitLabel}</button>
    </form>
  );
}
