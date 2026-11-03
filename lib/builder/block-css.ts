/**
 * Layout rules every builder block needs, independent of any one node.
 *
 * **Emitted once per storefront page, by `ThemeRoot`**, right after the theme
 * stylesheet and before any document's own compiled styles. That order is the
 * cascade the builder relies on — theme, then these, then each node's styles
 * — and it must hold however many documents a page renders (M4: an
 * announcement bar, a header, the page, a footer). A copy per document would
 * put a later document's base rules after an earlier one's node styles and
 * undo them (a header row hidden on phones would reappear).
 */
export const BLOCK_CSS = [
  ".mk-page{display:block}",
  ".mk-b-section{display:block}",
  ".mk-b-section>*:last-child{margin-bottom:0}",
  ".mk-b-columns{display:grid;grid-template-columns:minmax(0,1fr)}",
  ...(["sm", "md", "lg"] as const).flatMap((bp) => {
    const px = { sm: 640, md: 768, lg: 1024 }[bp];
    return [2, 3, 4].map(
      (n) => `@media (min-width:${px}px){.mk-stack-${bp}.mk-cols-${n}{grid-template-columns:repeat(${n},minmax(0,1fr))}}`,
    );
  }),
  ".mk-b-grid,.mk-b-repeater{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--mk-min,16rem),1fr))}",
  ".mk-b-repeater{list-style:none;padding:0;margin:0}.mk-b-repeater>li{min-width:0}",
  ".mk-grid-sm{--mk-min:12rem}.mk-grid-md{--mk-min:16rem}.mk-grid-lg{--mk-min:22rem}",
  ".mk-b-row{display:flex;flex-wrap:wrap;align-items:center}.mk-nowrap{flex-wrap:nowrap}",
  ".mk-justify-start{justify-content:flex-start}.mk-justify-center{justify-content:center}",
  ".mk-justify-end{justify-content:flex-end}.mk-justify-between{justify-content:space-between}",
  ".mk-b-heading{font-family:var(--sf-font-display);line-height:1.15;letter-spacing:-0.02em;margin:0 0 .6em}",
  ".mk-b-text p{margin:0 0 1em}.mk-b-text p:last-child{margin-bottom:0}.mk-b-text a{text-decoration:underline;text-underline-offset:2px}",
  ".mk-b-text ul,.mk-b-text ol,.mk-b-list{margin:0 0 1em;padding-left:1.25em}",
  ".mk-b-image{margin:0}.mk-b-image img{display:block;width:100%;height:auto;border-radius:var(--sf-radius)}",
  ".mk-b-image figcaption{color:var(--sf-muted);font-size:.875rem;margin-top:.5rem}",
  ".mk-aspect-1-1 img{aspect-ratio:1/1;object-fit:cover}.mk-aspect-4-3 img{aspect-ratio:4/3;object-fit:cover}",
  ".mk-aspect-16-9 img{aspect-ratio:16/9;object-fit:cover}.mk-aspect-3-4 img{aspect-ratio:3/4;object-fit:cover}",
  ".mk-btn-secondary{background:transparent;color:var(--sf-fg);border:1px solid var(--sf-border)}",
  ".mk-btn-link{background:none;color:var(--sf-accent);padding:0;text-decoration:underline}",
  ".mk-b-details{border-top:1px solid var(--sf-border);padding:.75rem 0}.mk-b-details summary{cursor:pointer;font-weight:600}",
  ".mk-b-details>div{margin-top:.5rem}",
  ".mk-b-testimonial{margin:0}.mk-b-testimonial blockquote{margin:0 0 .5rem;font-size:1.15rem;font-family:var(--sf-font-display)}",
  ".mk-b-testimonial figcaption{color:var(--sf-muted)}",
  ".mk-b-video{position:relative;aspect-ratio:16/9}.mk-b-video iframe{position:absolute;inset:0;width:100%;height:100%;border:0}",
  ".mk-b-divider{border:0;border-top:1px solid var(--sf-border);margin:1.5rem 0}",
  ".mk-b-collections{list-style:none;padding:0;margin:0;display:grid;gap:1rem}",
  ".mk-space-0{height:0}.mk-space-xs{height:.25rem}.mk-space-sm{height:.5rem}.mk-space-md{height:1rem}",
  ".mk-space-lg{height:1.5rem}.mk-space-xl{height:2.5rem}.mk-space-2xl{height:4rem}.mk-space-3xl{height:6rem}",
  ".mk-b-productGallery{display:grid;gap:.5rem;margin:0}.mk-gallery-grid{grid-template-columns:repeat(2,minmax(0,1fr))}",
  ".mk-b-productGallery img{display:block;width:100%;height:auto;border-radius:var(--sf-radius);background:var(--sf-border)}",
  ".mk-menu-column{flex-direction:column;align-items:flex-start}",
  ".mk-b-storeBrand{display:inline-flex;align-items:center;gap:.5rem}.mk-b-storeBrand img{height:2rem;width:auto;display:block}",
  ".mk-region-footer{border-top:1px solid var(--sf-border);margin-top:3rem}",
  ".mk-region-announcement p{margin:0}",
].join("");
