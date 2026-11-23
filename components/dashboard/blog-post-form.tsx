"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createPreviewSession } from "@/lib/api/builder";
import {
  createBlogPost,
  deleteBlogPost,
  publishBlogPost,
  unpublishBlogPost,
  updateBlogPost,
  type BlogPost,
  type PostStatus,
} from "@/lib/api/blog";
import { uploadProductImage } from "@/lib/api/uploads";
import { ApiClientError } from "@/lib/api/types";
import { publicErrorMessage } from "@/lib/api/public-copy";
import type { PageSeo } from "@markii/renderer/types";
import { UndoBar } from "@/components/dashboard/undo-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label, Textarea } from "@/components/ui/field";
import { Toggle } from "@/components/ui/toggle";

const STATUS: Record<PostStatus, { label: string; variant: "neutral" | "info" | "success" }> = {
  draft: { label: "Draft", variant: "neutral" },
  scheduled: { label: "Scheduled", variant: "info" },
  published: { label: "Published", variant: "success" },
};

function seoPayload(s: PageSeo): PageSeo {
  const out: PageSeo = {};
  if (s.title?.trim()) out.title = s.title.trim();
  if (s.description?.trim()) out.description = s.description.trim();
  if (s.ogImage?.trim()) out.ogImage = s.ogImage.trim();
  if (s.noindex) out.noindex = true;
  return out;
}

export function BlogPostForm({
  siteId,
  siteSlug,
  post,
  canWrite,
}: {
  siteId: number;
  siteSlug: string;
  post?: BlogPost;
  canWrite: boolean;
}) {
  const router = useRouter();
  const editing = Boolean(post);
  const [title, setTitle] = useState(post?.title ?? "");
  const [handle, setHandle] = useState(post?.handle ?? "");
  const [excerpt, setExcerpt] = useState(post?.autoExcerpt ?? "");
  const [body, setBody] = useState(post?.body ?? "");
  const [coverImage, setCoverImage] = useState(post?.coverImage ?? "");
  const [coverAlt, setCoverAlt] = useState(post?.coverAlt ?? "");
  const [author, setAuthor] = useState(post?.author ?? "");
  const [seo, setSeo] = useState<PageSeo>(post?.seo ?? {});
  const [redirectOldLink, setRedirectOldLink] = useState(true);
  const [scheduleAt, setScheduleAt] = useState("");
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [undo, setUndo] = useState<{ actionId: string; invocationId: string; message: string } | null>(null);

  const status = post?.status ?? "draft";
  const handleChanged = editing && post && handle.trim() !== post.handle && status !== "draft";

  useEffect(() => {
    const h = (post?.handle || handle).trim();
    if (!h) return;
    let cancelled = false;
    createPreviewSession(siteId)
      .then((r) => {
        if (!cancelled) setPreviewSrc(`${r.url}/blog/${h}`);
      })
      .catch(() => {
        if (!cancelled) setPreviewSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [siteId, post?.handle, handle]);

  function fields() {
    return {
      title: title.trim(),
      handle: handle.trim() || undefined,
      excerpt: excerpt.trim() || undefined,
      body,
      coverImage: coverImage.trim() || null,
      coverAlt: coverAlt.trim(),
      author: author.trim() || undefined,
      seo: seoPayload(seo),
    };
  }

  async function save() {
    if (!title.trim()) {
      setError("Title is required.");
      return false;
    }
    if (coverImage.trim() && !coverAlt.trim()) {
      setFieldError("Cover image needs alt text.");
      return false;
    }
    setError(null);
    setFieldError(null);
    setWarning(null);
    setBusy(true);
    try {
      if (editing && post) {
        const out = await updateBlogPost({
          postId: post.id,
          ...fields(),
          redirectOldLink: handleChanged ? redirectOldLink : undefined,
        });
        if (!out.ok) {
          setError("The post could not be saved.");
          return false;
        }
        if (out.undoable) setUndo({ actionId: "blog.updatePost", invocationId: out.invocationId, message: "Post saved." });
        if (out.result && out.result.handle !== post.handle) {
          router.replace(`/dashboard/websites/${siteSlug}/blog/${post.id}`);
        }
        router.refresh();
        return true;
      }
      const out = await createBlogPost({ siteId, ...fields() });
      if (!out.ok || !out.result) {
        setError("The post could not be created.");
        return false;
      }
      router.push(`/dashboard/websites/${siteSlug}/blog/${out.result.postId}`);
      router.refresh();
      return true;
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : publicErrorMessage(err, "Save failed."));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <form
        className="max-w-2xl space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          await save();
        }}
      >
        {undo ? <UndoBar {...undo} onUndone={() => router.refresh()} /> : null}
        {error ? <p className="text-sm text-error-text">{error}</p> : null}
        {warning ? <p className="text-sm text-warning-text">{warning}</p> : null}

        <p className="text-sm leading-6 text-muted">
          Posts publish on their own. Once a post is live, saving changes updates it straight away.
        </p>

        {post ? (
          <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>
        ) : null}

        <div>
          <Label htmlFor="post-title">Title</Label>
          <Input id="post-title" value={title} disabled={!canWrite} onChange={(e) => setTitle(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="post-handle">Handle</Label>
          <Input
            id="post-handle"
            value={handle}
            disabled={!canWrite}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="auto from title"
            className="font-mono"
          />
          {handleChanged ? (
            <label className="mt-2 flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={redirectOldLink} onChange={(e) => setRedirectOldLink(e.target.checked)} />
              Send the old link here
            </label>
          ) : null}
        </div>
        <div>
          <Label htmlFor="post-body">Body (Markdown)</Label>
          <Textarea id="post-body" rows={16} value={body} disabled={!canWrite} onChange={(e) => setBody(e.target.value)} className="font-mono" />
          <div className="mt-2 rounded-[var(--radius-control)] border border-border bg-hover-soft p-3 text-xs leading-5 text-muted">
            Paragraphs, <code>##</code>/<code>###</code> headings (<code>#</code> reads as <code>##</code> — the title is
            the page&apos;s only h1), <code>-</code>/<code>1.</code> lists, <code>**bold**</code>, <code>*italic*</code>,{" "}
            <code>`code`</code>, <code>[links](/path)</code>, <code>![alt](https://…)</code> on its own line,{" "}
            <code>&gt;</code> quotes, fenced code and <code>---</code>. Raw HTML shows as text.
          </div>
        </div>
        <div>
          <Label htmlFor="post-excerpt">Excerpt</Label>
          <Textarea id="post-excerpt" rows={2} value={excerpt} disabled={!canWrite} onChange={(e) => setExcerpt(e.target.value)} />
          <p className="mt-1 text-xs text-muted">Leave empty to use the opening words of the body.</p>
        </div>
        <div>
          <Label htmlFor="post-author">Author</Label>
          <Input id="post-author" value={author} disabled={!canWrite} onChange={(e) => setAuthor(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="cover-url">Cover image</Label>
          <div className="flex flex-wrap gap-2">
            <Input id="cover-url" value={coverImage} disabled={!canWrite} onChange={(e) => setCoverImage(e.target.value)} placeholder="https://…" />
            {canWrite ? (
              <label className="inline-flex cursor-pointer items-center justify-center rounded-[var(--radius-control)] border border-border bg-surface px-4 py-2.5 text-sm font-medium hover:bg-hover-soft">
                Upload
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    setBusy(true);
                    try {
                      const { url } = await uploadProductImage(file);
                      setCoverImage(url);
                    } catch (err) {
                      setError(publicErrorMessage(err, "Upload failed."));
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
              </label>
            ) : null}
          </div>
        </div>
        <div>
          <Label htmlFor="cover-alt">Cover alt text</Label>
          <Input id="cover-alt" value={coverAlt} disabled={!canWrite} onChange={(e) => setCoverAlt(e.target.value)} />
          <FieldError>{fieldError}</FieldError>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-foreground">Search</legend>
          <div>
            <Label htmlFor="seo-title">Search title</Label>
            <Input id="seo-title" maxLength={120} disabled={!canWrite} value={seo.title ?? ""} onChange={(e) => setSeo({ ...seo, title: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="seo-desc">Search description</Label>
            <Input id="seo-desc" maxLength={320} disabled={!canWrite} value={seo.description ?? ""} onChange={(e) => setSeo({ ...seo, description: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="seo-image">Share image</Label>
            <Input id="seo-image" maxLength={2000} disabled={!canWrite} value={seo.ogImage ?? ""} onChange={(e) => setSeo({ ...seo, ogImage: e.target.value })} />
          </div>
          <Toggle
            checked={Boolean(seo.noindex)}
            disabled={!canWrite}
            label="Hide from search engines and AI agents"
            onChange={(noindex) => setSeo({ ...seo, noindex })}
          />
        </fieldset>

        {canWrite ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
            {editing && post && status === "draft" ? (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={async () => {
                    const ok = await save();
                    if (!ok || !post) return;
                    setBusy(true);
                    try {
                      const out = await publishBlogPost({ postId: post.id });
                      if (out.result?.warnings?.length) setWarning(out.result.warnings.map((w) => w.message).join(" "));
                      if (out.ok && out.undoable) {
                        setUndo({ actionId: "blog.publishPost", invocationId: out.invocationId, message: "Published." });
                      }
                      router.refresh();
                    } catch (err) {
                      setError(err instanceof ApiClientError ? err.message : publicErrorMessage(err, "Could not publish."));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Publish
                </Button>
                <div className="flex items-center gap-2">
                  <Input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} disabled={busy} />
                  <Button
                    variant="secondary"
                    disabled={busy || !scheduleAt}
                    onClick={async () => {
                      const ok = await save();
                      if (!ok || !post || !scheduleAt) return;
                      setBusy(true);
                      try {
                        const out = await publishBlogPost({ postId: post.id, at: new Date(scheduleAt).toISOString() });
                        if (out.result?.warnings?.length) setWarning(out.result.warnings.map((w) => w.message).join(" "));
                        if (out.ok && out.undoable) {
                          setUndo({ actionId: "blog.publishPost", invocationId: out.invocationId, message: "Scheduled." });
                        }
                        router.refresh();
                      } catch (err) {
                        setError(err instanceof ApiClientError ? err.message : publicErrorMessage(err, "Could not schedule."));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Schedule
                  </Button>
                </div>
              </>
            ) : null}
            {editing && post && status !== "draft" ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const out = await unpublishBlogPost({ postId: post.id });
                    if (out.ok && out.undoable) {
                      setUndo({ actionId: "blog.unpublishPost", invocationId: out.invocationId, message: "Unpublished." });
                    }
                    router.refresh();
                  } catch (err) {
                    setError(publicErrorMessage(err, "Could not unpublish."));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Unpublish
              </Button>
            ) : null}
            {editing && post && status === "draft" ? (
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            ) : editing && post ? (
              <p className="text-xs text-muted">Unpublish it first to delete.</p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted">You can view this post but not change it.</p>
        )}
      </form>

      <aside className="space-y-3">
        <p className="text-sm font-medium text-foreground">Preview</p>
        <p className="text-xs text-muted">The storefront renderer — drafts show here, labelled. Not a second parser.</p>
        {previewSrc ? (
          <iframe title="Post preview" src={previewSrc} className="h-[32rem] w-full rounded-[var(--radius-card)] border border-border bg-canvas" />
        ) : (
          <p className="text-sm text-muted">Save a handle to preview.</p>
        )}
      </aside>
    </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this draft?"
        description="Live and scheduled posts cannot be deleted. This cannot be undone."
        confirmLabel="Delete"
        danger
        busy={busy}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          if (!post) return;
          setBusy(true);
          try {
            await deleteBlogPost({ postId: post.id });
            router.push(`/dashboard/websites/${siteSlug}/blog`);
            router.refresh();
          } catch (err) {
            setError(publicErrorMessage(err, "The post could not be deleted."));
            setConfirmDelete(false);
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}
