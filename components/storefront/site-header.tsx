type NavItem = { name: string; href: string };

export function SiteHeader({
  siteName,
  homeHref,
  nav,
  cartHref,
  accountHref,
}: {
  siteName: string;
  homeHref: string;
  nav: NavItem[];
  cartHref?: string;
  accountHref?: string;
}) {
  return (
    <header className="sf-header">
      <div className="sf-header-inner">
        <a className="sf-brand" href={homeHref}>
          {siteName}
        </a>
        {nav.length > 0 ? (
          <nav className="sf-nav" aria-label="Categories">
            {nav.map((item) => (
              <a key={item.href} href={item.href}>
                {item.name}
              </a>
            ))}
          </nav>
        ) : null}
        {accountHref || cartHref ? (
          <div className="sf-header-actions">
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
