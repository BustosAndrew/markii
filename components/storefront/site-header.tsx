type NavItem = { name: string; href: string };

export function SiteHeader({
  siteName,
  homeHref,
  nav,
}: {
  siteName: string;
  homeHref: string;
  nav: NavItem[];
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
      </div>
    </header>
  );
}
