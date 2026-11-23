"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FORM_FIELD_TYPES, type FormFieldType } from "@markii/renderer/forms";
import {
  createForm,
  deleteForm,
  updateForm,
  type FormFieldsInput,
  type StoreForm,
} from "@/lib/api/forms";
import { ApiClientError } from "@/lib/api/types";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { UndoBar } from "@/components/dashboard/undo-bar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/field";
import { Toggle } from "@/components/ui/toggle";

type DraftField = FormFieldsInput;

function blankField(): DraftField {
  return { name: "email", label: "Email", type: "email", required: true };
}

function fieldNameFromLabel(label: string) {
  const n = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(n) ? n : `f_${n}`.slice(0, 40);
}

export function FormEditor({
  siteId,
  siteSlug,
  form,
  canWrite,
}: {
  siteId: number;
  siteSlug: string;
  form?: StoreForm;
  canWrite: boolean;
}) {
  const router = useRouter();
  const editing = Boolean(form);
  const [name, setName] = useState(form?.name ?? "");
  const [handle, setHandle] = useState(form?.handle ?? "");
  const [fields, setFields] = useState<DraftField[]>(form?.fields.length ? form.fields : [blankField()]);
  const [submitLabel, setSubmitLabel] = useState(form?.submitLabel ?? "Send");
  const [successMessage, setSuccessMessage] = useState(form?.successMessage ?? "Thanks — we got your message.");
  const [notifyEmail, setNotifyEmail] = useState(form?.notifyEmail ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [undo, setUndo] = useState<{ actionId: string; invocationId: string; message: string } | null>(null);

  function setField(i: number, patch: Partial<DraftField>) {
    setFields((prev) => prev.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canWrite) return;
    setError(null);
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (fields.length === 0) {
      setError("A form needs at least one field.");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        fields: fields.map((f) => ({
          name: f.name.trim(),
          label: f.label.trim(),
          type: f.type,
          required: Boolean(f.required),
          placeholder: f.placeholder?.trim() || undefined,
          maxLength: f.maxLength,
          options: f.type === "select" ? (f.options ?? []).map((o) => o.trim()).filter(Boolean) : undefined,
        })),
        submitLabel: submitLabel.trim() || undefined,
        successMessage: successMessage.trim() || undefined,
        notifyEmail: notifyEmail.trim() || null,
      };
      if (editing && form) {
        const out = await updateForm({ formId: form.id, ...payload });
        if (!out.ok) {
          setError("The form could not be saved.");
          return;
        }
        if (out.undoable) setUndo({ actionId: "forms.updateForm", invocationId: out.invocationId, message: "Form saved." });
        router.refresh();
      } else {
        const out = await createForm({
          siteId,
          ...payload,
          handle: handle.trim() || undefined,
        });
        if (!out.ok || !out.result) {
          setError("The form could not be created.");
          return;
        }
        router.push(`/dashboard/websites/${siteSlug}/forms/${out.result.formId}`);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : publicErrorMessage(err, "Save failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-6">
      {undo ? <UndoBar {...undo} onUndone={() => router.refresh()} /> : null}
      {error ? <p className="text-sm text-error-text">{error}</p> : null}

      <p className="text-sm leading-6 text-muted">
        A form is live at once at <span className="font-mono">/forms/{form?.handle || handle || "…"}</span>. Shoppers
        post it as ordinary HTML — no script.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="form-name">Name</Label>
          <Input id="form-name" value={name} onChange={(e) => setName(e.target.value)} required disabled={!canWrite} />
        </div>
        <div>
          <Label htmlFor="form-handle">Handle</Label>
          <Input
            id="form-handle"
            value={editing ? (form?.handle ?? "") : handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="auto from name"
            className="font-mono"
            disabled={!canWrite || editing}
            readOnly={editing}
          />
          <p className="mt-1 text-xs text-muted">
            {editing ? "Fixed after creation — pages name the form by it." : "Optional. Cannot change later."}
          </p>
        </div>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-foreground">Fields</legend>
        {fields.map((field, i) => (
          <div key={i} className="space-y-3 rounded-[var(--radius-control)] border border-border p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor={`f-${i}-label`}>Label</Label>
                <Input
                  id={`f-${i}-label`}
                  value={field.label}
                  disabled={!canWrite}
                  onChange={(e) => {
                    const label = e.target.value;
                    const auto = fieldNameFromLabel(label);
                    const keepName = field.name !== fieldNameFromLabel(field.label);
                    setField(i, { label, name: keepName ? field.name : auto });
                  }}
                />
              </div>
              <div>
                <Label htmlFor={`f-${i}-name`}>Name</Label>
                <Input
                  id={`f-${i}-name`}
                  value={field.name}
                  className="font-mono"
                  disabled={!canWrite}
                  onChange={(e) => setField(i, { name: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor={`f-${i}-type`}>Type</Label>
                <Select
                  id={`f-${i}-type`}
                  value={field.type}
                  disabled={!canWrite}
                  onChange={(e) => {
                    const type = e.target.value as FormFieldType;
                    setField(i, {
                      type,
                      options: type === "select" ? field.options?.length ? field.options : ["Option 1"] : undefined,
                    });
                  }}
                >
                  {FORM_FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </div>
              {field.type !== "checkbox" && field.type !== "select" ? (
                <div>
                  <Label htmlFor={`f-${i}-ph`}>Placeholder (optional)</Label>
                  <Input
                    id={`f-${i}-ph`}
                    value={field.placeholder ?? ""}
                    disabled={!canWrite}
                    onChange={(e) => setField(i, { placeholder: e.target.value })}
                  />
                </div>
              ) : null}
            </div>
            {field.type === "select" ? (
              <div>
                <Label htmlFor={`f-${i}-opts`}>Choices (one per line)</Label>
                <Textarea
                  id={`f-${i}-opts`}
                  rows={3}
                  disabled={!canWrite}
                  value={(field.options ?? []).join("\n")}
                  onChange={(e) => setField(i, { options: e.target.value.split("\n") })}
                />
              </div>
            ) : null}
            {field.type === "text" || field.type === "textarea" ? (
              <div>
                <Label htmlFor={`f-${i}-max`}>Max length (optional)</Label>
                <Input
                  id={`f-${i}-max`}
                  type="number"
                  min={1}
                  max={5000}
                  disabled={!canWrite}
                  value={field.maxLength ?? ""}
                  onChange={(e) => setField(i, { maxLength: e.target.value ? Number(e.target.value) : undefined })}
                />
              </div>
            ) : null}
            <Toggle
              checked={Boolean(field.required)}
              disabled={!canWrite}
              label="Required"
              onChange={(required) => setField(i, { required })}
            />
            {canWrite && fields.length > 1 ? (
              <Button variant="ghost" onClick={() => setFields((prev) => prev.filter((_, j) => j !== i))}>
                Remove field
              </Button>
            ) : null}
          </div>
        ))}
        {canWrite && fields.length < 20 ? (
          <Button variant="secondary" onClick={() => setFields((prev) => [...prev, { name: `field_${prev.length + 1}`, label: "New field", type: "text", required: false }])}>
            Add field
          </Button>
        ) : null}
      </fieldset>

      <div>
        <Label htmlFor="submit-label">Button label</Label>
        <Input id="submit-label" value={submitLabel} disabled={!canWrite} onChange={(e) => setSubmitLabel(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="thanks">Thank-you message</Label>
        <Textarea id="thanks" rows={2} value={successMessage} disabled={!canWrite} onChange={(e) => setSuccessMessage(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="notify">Email each submission to</Label>
        <Input
          id="notify"
          type="email"
          value={notifyEmail}
          disabled={!canWrite}
          onChange={(e) => setNotifyEmail(e.target.value)}
          placeholder="Leave empty to keep it on the store only"
        />
      </div>

      {canWrite ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : editing ? "Save" : "Create form"}
          </Button>
          {editing && form ? (
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted">You can view this form but not change it.</p>
      )}
      {editing ? (
        <p className="text-sm text-muted">
          Submissions are kept if you delete the form. Remove it from any page that shows it first.
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this form?"
        description="Submissions are kept and stay readable. This cannot be undone. If a page still shows the form, delete is refused."
        confirmLabel="Delete"
        danger
        busy={busy}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          if (!form) return;
          setBusy(true);
          setError(null);
          try {
            await deleteForm({ formId: form.id });
            router.push(`/dashboard/websites/${siteSlug}/forms`);
            router.refresh();
          } catch (err) {
            const pages =
              err instanceof ApiClientError &&
              err.details &&
              typeof err.details === "object" &&
              Array.isArray((err.details as { pages?: unknown }).pages)
                ? ((err.details as { pages: string[] }).pages)
                : null;
            setError(
              pages && pages.length
                ? `This form is on ${pages.map((p) => `"${p}"`).join(", ")}. Remove it there first.`
                : publicErrorMessage(err, "The form could not be deleted."),
            );
            setConfirmDelete(false);
          } finally {
            setBusy(false);
          }
        }}
      />
    </form>
  );
}
