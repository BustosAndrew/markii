import { dashboardOrigin } from "@/lib/builder/preview";

/**
 * The builder's live-preview bridge (D51, M2) — the **only** script a
 * storefront page ever carries outside the sanctioned islands, and only in the
 * preview. `ThemeRoot` renders it when `data.preview` is true; published pages
 * never include it (a test asserts there is no `data-mk-node` or bridge in
 * live HTML).
 *
 * It does four things, all through `postMessage` to the dashboard's origin
 * and nowhere else: report the path the merchant navigated to, report which
 * block they clicked — and which document it belongs to, since a page shows
 * its header and footer too (M4) — outline the block the editor selected, and
 * keep the scroll position across the reloads that follow every edit.
 *
 * The script is a fixed string. The one value interpolated is the dashboard
 * origin, JSON-encoded, and the messages it accepts are checked against it.
 */
const SCRIPT = (parent: string) => `(function(){
var P=${JSON.stringify(parent)};
function post(m){try{window.parent.postMessage(m,P)}catch(e){}}
var key="mk-scroll:"+location.pathname+location.search;
try{var y=sessionStorage.getItem(key);if(y){window.scrollTo(0,+y)}}catch(e){}
window.addEventListener("pagehide",function(){try{sessionStorage.setItem(key,String(window.scrollY))}catch(e){}});
post({type:"markii:location",path:location.pathname+location.search});
document.addEventListener("click",function(e){
var t=e.target;var el=t&&t.closest?t.closest("[data-mk-node]"):null;
if(!el)return;
var doc=el.closest("[data-mk-doc]");
post({type:"markii:select",nodeId:el.getAttribute("data-mk-node"),docId:doc?doc.getAttribute("data-mk-doc"):null});
if(e.altKey||e.metaKey){e.preventDefault()}
},true);
var sel=null;
window.addEventListener("message",function(e){
if(e.origin!==P)return;var d=e.data||{};
if(d.type!=="markii:highlight")return;
var id=d.nodeId?String(d.nodeId).replace(/[^a-z0-9_]/g,""):"";
/* A style rule, not an attribute: React owns these elements, and touching them before hydration is a mismatch. */
if(!sel){sel=document.createElement("style");document.head.appendChild(sel)}
sel.textContent=id?'[data-mk-node="'+id+'"]{outline:2px solid #C9184A!important;outline-offset:-2px}':"";
if(id&&d.scroll){var n=document.querySelector('[data-mk-node="'+id+'"]');if(n){n.scrollIntoView({block:"nearest",behavior:"smooth"})}}
});
})();`;

const STYLE =
  "[data-mk-node]:not(.mk-page):hover{outline:1px dashed rgba(201,24,74,.55);outline-offset:-1px;cursor:pointer}" +
  "[data-mk-empty]{min-height:4rem;border:1px dashed var(--sf-border);display:flex;align-items:center;justify-content:center}" +
  "[data-mk-empty]::after{content:'Choose ' attr(data-mk-empty);color:var(--sf-muted);font-size:.875rem}";

export function PreviewBridge() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      <script dangerouslySetInnerHTML={{ __html: SCRIPT(dashboardOrigin()) }} />
    </>
  );
}
