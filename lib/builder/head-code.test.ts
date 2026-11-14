import { describe, expect, it } from "vitest";
import { roleHasPermission } from "@/lib/auth/permissions";
import { cleanHeadCode, parseHeadCode, serializeHeadCode } from "./head-code";

/**
 * M6 custom scripts. The merchant's JavaScript is meant to run, so these do not
 * test that script is removed — they test that what is stored is exactly what
 * renders, and that nothing outside the four kept shapes slips through.
 */

const GA =
  '<!-- Google tag (gtag.js) -->\n<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>\n' +
  "<script>\n  window.dataLayer = window.dataLayer || [];\n  function gtag(){dataLayer.push(arguments);}\n  gtag('js', new Date());\n  gtag('config', 'G-ABC123');\n</script>";

const META_PIXEL =
  "<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){};}(window, document,'script');fbq('init', '123');</script>\n" +
  '<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=123&ev=PageView&noscript=1"/></noscript>';

describe("head code is rebuilt into the shapes that render", () => {
  it("keeps a Google tag snippet working, comment dropped", () => {
    const { html, removed, problems } = cleanHeadCode(GA);
    expect(problems).toEqual([]);
    expect(removed).toEqual([]);
    expect(html).toContain('<script src="https://www.googletagmanager.com/gtag/js?id=G-ABC123" async></script>');
    expect(html).toContain("gtag('config', 'G-ABC123');");
    expect(html).not.toContain("<!--");
  });

  it("keeps a Meta pixel, with its noscript image as a plain https image", () => {
    const { html } = cleanHeadCode(META_PIXEL);
    expect(html).toContain("fbq('init', '123')");
    expect(html).toContain('<noscript><img src="https://www.facebook.com/tr?id=123&amp;ev=PageView&amp;noscript=1" width="1" height="1" alt=""></noscript>');
  });

  it("keeps verification meta tags and preconnects", () => {
    const { html } = cleanHeadCode('<meta name="google-site-verification" content="abc"><meta property="fb:app_id" content="1"><link rel="preconnect" href="https://cdn.test/" crossorigin>');
    expect(html).toBe('<meta name="google-site-verification" content="abc">\n<meta property="fb:app_id" content="1">\n<link rel="preconnect" href="https://cdn.test" crossorigin>');
  });

  it("is idempotent — cleaning what was stored changes nothing", () => {
    for (const input of [GA, META_PIXEL]) {
      const once = cleanHeadCode(input).html;
      expect(cleanHeadCode(once).html).toBe(once);
      expect(serializeHeadCode(parseHeadCode(once).elements)).toBe(once);
    }
  });
});

describe("what does not survive, and is named", () => {
  const cases: [string, RegExp][] = [
    ['<meta http-equiv="Content-Security-Policy" content="script-src *">', /http-equiv/],
    ['<meta http-equiv="refresh" content="0;url=https://evil.test">', /http-equiv/],
    ['<script src="http://insecure.test/a.js"></script>', /not an https/],
    ['<script src="//cdn.test/a.js"></script>', /not an https/],
    ['<script src="javascript:alert(1)"></script>', /not an https/],
    ['<script type="text/x-template">x</script>', /type="text\/x-template"/],
    ["<script>var s='<!--';</script>", /change where browsers think/],
    ['<iframe src="https://evil.test"></iframe>', /<iframe>/],
    ['<base href="https://evil.test/">', /<base>/],
    ['<link rel="stylesheet" href="https://cdn.test/a.css">', /Custom CSS/],
    ['<meta name="viewport" content="width=1">', /storefront sets it/],
    ['<meta name="robots" content="noindex">', /storefront sets it/],
    ['<noscript><iframe src="https://www.googletagmanager.com/ns.html"></iframe></noscript>', /inside <noscript>/],
    ["just some text", /text outside/],
  ];
  for (const [input, why] of cases) {
    it(input.slice(0, 60), () => {
      const { elements, removed } = parseHeadCode(input);
      expect(elements).toEqual([]);
      expect(removed.join(" | ")).toMatch(why);
    });
  }

  it("drops attributes it does not know, including a pasted nonce and event handlers", () => {
    const { elements, removed } = parseHeadCode('<script nonce="guess" onload="x()" data-domain="shop.test" src="https://plausible.io/js/script.js" defer></script>');
    expect(serializeHeadCode(elements)).toBe('<script src="https://plausible.io/js/script.js" defer data-domain="shop.test"></script>');
    expect(removed).toEqual(expect.arrayContaining(["the nonce attribute on <script>", "the onload attribute on <script>"]));
  });

  it("refuses code with nothing usable, and code that is too long", () => {
    expect(cleanHeadCode("<iframe></iframe>").problems).toHaveLength(1);
    expect(cleanHeadCode("x".repeat(20_001)).problems[0]).toMatch(/20,000/);
    expect(cleanHeadCode("   ").problems).toEqual([]);
  });

  it("cannot be ended early: a stored script never contains its own end tag", () => {
    // The parser ends the script at </script>; what follows is a separate (dropped) text node.
    const { html } = cleanHeadCode("<script>var a = 1;</script><img src=x onerror=alert(1)>");
    expect(html).toBe("<script>var a = 1;</script>");
  });
});

describe("who may write it", () => {
  it("is cms.scripts — owner, administrator, developer, and nobody else", () => {
    for (const role of ["owner", "administrator", "developer"] as const) expect(roleHasPermission(role, "cms.scripts"), role).toBe(true);
    for (const role of ["catalog_manager", "commerce_manager", "analyst", "viewer"] as const) expect(roleHasPermission(role, "cms.scripts"), role).toBe(false);
  });
});
