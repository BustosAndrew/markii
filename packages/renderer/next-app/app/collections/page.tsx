import { notFound } from "next/navigation";
import { getStore } from "../../lib/markii";
import { listingTree } from "../../lib/listing";
import { StorePage } from "../../lib/page";

/** Every published collection. */
export default async function CollectionsIndex() {
  const store = await getStore();
  if (!store || store.collections.length === 0) notFound();
  return (
    <StorePage
      store={store}
      tree={listingTree([
        { type: "heading", props: { text: "Collections", level: 1 } },
        { type: "collectionList", props: { limit: 24, showDescriptions: true } },
      ])}
    />
  );
}
