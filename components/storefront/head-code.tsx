import { parseHeadCode } from "@/lib/builder/head-code";
import { requestNonce } from "@/lib/storefront/nonce";

/**
 * The merchant's custom scripts (D51 M6), rendered by `StoreTop` on every
 * storefront page **except** the cart, account and the builder preview.
 *
 * Parsed again here rather than trusted from the column — the same reason
 * custom HTML is sanitised on render as well as on save: a rule made stricter
 * later also covers what was stored before it.
 *
 * Every script carries this request's CSP nonce, which is what lets it run
 * under the storefront policy; a script the merchant did not write through
 * `builder.setHeadCode` has no way to get one. React hoists `<meta>`,
 * `<link>` and `async` scripts into `<head>`; inline scripts run where they
 * stand, at the top of the page body, before any store content.
 */
export async function StoreHeadCode({ html }: { html: string }) {
  const { elements } = parseHeadCode(html);
  if (elements.length === 0) return null;
  const nonce = await requestNonce();
  return (
    <>
      {elements.map((e, i) => {
        switch (e.kind) {
          case "script": {
            const data = Object.fromEntries(e.data);
            const common = {
              nonce,
              type: e.type ?? undefined,
              id: e.id ?? undefined,
              crossOrigin: e.crossOrigin ?? undefined,
              integrity: e.integrity ?? undefined,
              referrerPolicy: (e.referrerPolicy ?? undefined) as React.HTMLAttributeReferrerPolicy | undefined,
              ...data,
            };
            return e.src ? (
              <script key={i} src={e.src} async={e.async || undefined} defer={e.defer || undefined} {...common} />
            ) : (
              <script key={i} {...common} dangerouslySetInnerHTML={{ __html: e.code }} />
            );
          }
          case "meta":
            return e.attr === "name" ? (
              <meta key={i} name={e.key} content={e.content} />
            ) : (
              <meta key={i} property={e.key} content={e.content} />
            );
          case "link":
            return <link key={i} rel={e.rel} href={e.href} crossOrigin={e.crossOrigin ? "anonymous" : undefined} />;
          case "noscript":
            return (
              <noscript key={i}>
                {e.images.map((img, j) => (
                  // eslint-disable-next-line @next/next/no-img-element -- a tracking pixel, not content
                  <img key={j} src={img.src} width={img.width ?? undefined} height={img.height ?? undefined} alt={img.alt} />
                ))}
              </noscript>
            );
        }
      })}
    </>
  );
}
