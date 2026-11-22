/**
 * Storefront form definitions — the fields a form asks for. Drawn by
 * `./forms-view` as a plain HTML `<form>` that posts to the store's own
 * `/api/forms/{handle}`: no script, no island, so it works with JavaScript off
 * and leaves nothing for a merchant's custom code to hook into.
 */
import { z } from "zod";

export const FORM_FIELD_TYPES = ["text", "email", "tel", "textarea", "select", "checkbox"] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export const FORM_FIELDS_MAX = 20;
export const FORM_HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The longest answer each type takes when the merchant sets no limit. */
export const DEFAULT_MAX_LENGTH: Record<FormFieldType, number> = {
  text: 200,
  email: 254,
  tel: 40,
  textarea: 5000,
  select: 80,
  checkbox: 5,
};

export const formFieldSchema = z
  .object({
    /** The key the answer is stored under: `email`, `order_number`. */
    name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Lowercase letters, digits and underscores, starting with a letter."),
    label: z.string().trim().min(1).max(80),
    type: z.enum(FORM_FIELD_TYPES),
    required: z.boolean().default(false),
    placeholder: z.string().max(120).optional(),
    /** `select` only: the choices, in order. */
    options: z.array(z.string().trim().min(1).max(80)).min(1).max(30).optional(),
    maxLength: z.number().int().min(1).max(5000).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.type === "select" && !f.options) ctx.addIssue({ code: "custom", message: `"${f.label}" is a choice — give it options.`, path: ["options"] });
    if (f.type !== "select" && f.options) ctx.addIssue({ code: "custom", message: "Only a choice field has options.", path: ["options"] });
  });

export type FormField = z.infer<typeof formFieldSchema>;

export const formFieldsSchema = z
  .array(formFieldSchema)
  .min(1, "A form needs at least one field.")
  .max(FORM_FIELDS_MAX)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    fields.forEach((f, i) => {
      if (seen.has(f.name)) ctx.addIssue({ code: "custom", message: `Two fields are named "${f.name}".`, path: [i, "name"] });
      seen.add(f.name);
    });
  });

/** A form as the storefront draws it — what the render context carries. */
export type RenderForm = {
  handle: string;
  name: string;
  fields: FormField[];
  submitLabel: string;
};

export function maxLengthOf(field: FormField): number {
  return field.maxLength ?? DEFAULT_MAX_LENGTH[field.type];
}
