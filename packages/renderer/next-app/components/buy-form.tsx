import type { ProductDetailJson } from "../lib/markii";

/**
 * Add to cart, as a plain form — no client JavaScript. It posts to this
 * app's `/cart/add`, whose server builds the cart on Markii (as the signed-in
 * shopper, when there is one) and sends the shopper to the store's hosted
 * checkout to pay.
 */
export function BuyForm({ product, locked, error }: { product: ProductDetailJson; locked: boolean; error?: string }) {
  const sellable = product.variants.length > 0 ? product.variants.filter((v) => v.available > 0) : null;
  const soldOut = sellable ? sellable.length === 0 : product.stock <= 0;
  return (
    <form className="sf-buy" method="post" action="/cart/add">
      <input type="hidden" name="productId" value={product.id} />
      <input type="hidden" name="slug" value={product.slug} />
      {sellable && product.variants.length > 1 ? (
        <label>
          Option{" "}
          <select name="variantId" defaultValue={sellable[0]?.id}>
            {product.variants.map((v) => (
              <option key={v.id} value={v.id} disabled={v.available <= 0}>
                {v.title}
                {v.available <= 0 ? " — sold out" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : sellable?.[0] ? (
        <input type="hidden" name="variantId" value={sellable[0].id} />
      ) : null}
      <label>
        Quantity <input type="number" name="quantity" min={1} max={99} defaultValue={1} />
      </label>
      {error ? <p role="alert" className="sf-muted">{error}</p> : null}
      <button type="submit" className="sf-button" disabled={locked || soldOut}>
        {locked ? "Members only" : soldOut ? "Sold out" : "Add to cart"}
      </button>
    </form>
  );
}
