import { formatPrice } from "@/lib/generators";

export function ProductCard({
  name,
  href,
  priceCents,
  currency,
  stock,
  imageUrl,
}: {
  name: string;
  href: string;
  priceCents: number;
  currency: string;
  stock: number;
  imageUrl?: string | null;
}) {
  return (
    <li>
      <a className="sf-card" href={href}>
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt={name} loading="lazy" />
        ) : null}
        <h2>{name}</h2>
        <p className="sf-price">{formatPrice(priceCents, currency)}</p>
        <p className="sf-muted">
          {stock > 0 ? `${stock} in stock` : "Out of stock"}
        </p>
      </a>
    </li>
  );
}
