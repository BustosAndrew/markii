type NavItem = { name: string; href: string };

export function SiteHeader({
  siteName,
  homeHref,
  nav,
  cartHref,
  accountHref,
  searchAction,
  searchQuery,
  collectionsHref,
}: {
  siteName: string;
  homeHref: string;
  nav: NavItem[];
  cartHref?: string;
  accountHref?: string;
  /**
   * Where the search form submits — the store's `/search` page. Absent on
   * pages that have no catalogue to search from (the cart, the account area).
   * A plain `GET` form and nothing else: storefronts are server-rendered
   * minimal HTML, and a search box does not earn an island.
   */
  searchAction?: string;
  /** The current query, so the box on a results page shows what was searched. */
  searchQuery?: string;
  /** The collections index, shown beside the categories only when the store has published any. */
  collectionsHref?: string;
}) {
  return (
    <header className="sf-header">
      <div className="sf-header-inner">
        <a className="sf-brand" href={homeHref}>
          {siteName}
        </a>
        {nav.length > 0 || collectionsHref ? (
          <nav className="sf-nav" aria-label="Categories">
            {nav.map((item) => (
              <a key={item.href} href={item.href}>
                {item.name}
              </a>
            ))}
            {collectionsHref ? <a href={collectionsHref}>Collections</a> : null}
          </nav>
        ) : null}
        {searchAction || accountHref || cartHref ? (
          <div className="sf-header-actions">
            {searchAction ? (
              <form className="sf-search" role="search" action={searchAction} method="get">
                <input
                  type="search"
                  name="q"
                  defaultValue={searchQuery ?? ""}
                  placeholder="Search products"
                  aria-label="Search products"
                  maxLength={200}
                />
                <button type="submit">Search</button>
              </form>
            ) : null}
            {accountHref ? (
              <a className="sf-cart-link" href={accountHref}>
                Account
              </a>
            ) : null}
            {cartHref ? (
              <a className="sf-cart-link" href={cartHref}>
                Cart
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}
