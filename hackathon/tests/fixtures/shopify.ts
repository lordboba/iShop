import type { RawCartResponse, RawCatalogSearchResponse } from "../../src/shopify/types";

// Raw MCP-shaped fixtures (NOT pre-normalized) mirroring the REAL Shopify UCP
// wire format — products carry variants inline; prices are integer minor
// units; sellers/checkout urls live on the variant — so fixture mode exercises
// the exact normalization paths used against live traffic.

const jacketSearch: RawCatalogSearchResponse = {
  products: [
    {
      id: "gid://shopify/p/aurora-jacket",
      title: "Aurora Field Jacket",
      description: "Weatherproof field jacket",
      media: [
        {
          type: "image",
          url: "https://cdn.aurora-outfitters.com/img/field-jacket.jpg",
          alt_text: "Aurora Field Jacket",
        },
      ],
      variants: [
        {
          id: "gid://shopify/ProductVariant/jacket-black",
          title: "Aurora Field Jacket - Black / M",
          url: "https://aurora-outfitters.com/products/field-jacket?variant=jacket-black",
          price: { amount: 8900, currency: "USD" },
          availability: { available: true },
          options: [
            { name: "Color", label: "Black" },
            { name: "Size", label: "M" },
          ],
          media: [
            { type: "image", url: "https://cdn.aurora-outfitters.com/img/field-jacket-black.jpg" },
          ],
          seller: {
            id: "gid://shopify/Shop/1001",
            name: "Aurora Outfitters",
            url: "https://aurora-outfitters.com",
            domain: "aurora-outfitters.com",
          },
          checkout_url: "https://aurora-outfitters.com/cart/jacket-black:1",
          eligible: { native_checkout: true },
        },
        {
          id: "gid://shopify/ProductVariant/jacket-navy",
          title: "Aurora Field Jacket - Navy / M",
          url: "https://aurora-outfitters.com/products/field-jacket?variant=jacket-navy",
          price: { amount: 9250, currency: "USD" },
          availability: { available: true },
          options: [
            { name: "Color", label: "Navy" },
            { name: "Size", label: "M" },
          ],
          seller: {
            id: "gid://shopify/Shop/1001",
            name: "Aurora Outfitters",
            url: "https://aurora-outfitters.com",
            domain: "aurora-outfitters.com",
          },
          checkout_url: "https://aurora-outfitters.com/cart/jacket-navy:1",
          eligible: { native_checkout: true },
        },
      ],
    },
    {
      id: "gid://shopify/p/everline-shell",
      title: "Everline Rain Shell",
      media: [{ type: "image", url: "https://cdn.everline.shop/img/rain-shell.jpg" }],
      variants: [
        {
          id: "gid://shopify/ProductVariant/shell-1",
          title: "Everline Rain Shell - Black / M",
          url: "https://everline.shop/products/rain-shell?variant=shell-1",
          price: { amount: 6400, currency: "USD" },
          availability: { available: true },
          options: [
            { name: "Color", label: "Black" },
            { name: "Size", label: "M" },
          ],
          seller: { name: "Everline", url: "https://everline.shop", domain: "everline.shop" },
          checkout_url: "https://everline.shop/cart/shell-1:1",
          eligible: { native_checkout: true },
        },
        // malformed: no variant id — must be dropped with a warn, not crash
        {
          title: "Everline Rain Shell - Olive / M",
          price: { amount: 5800, currency: "USD" },
          availability: { available: true },
          options: [
            { name: "Color", label: "Olive" },
            { name: "Size", label: "M" },
          ],
          seller: { name: "Everline", url: "https://everline.shop", domain: "everline.shop" },
        },
        // malformed: unparseable price — must be dropped with a warn
        {
          id: "gid://shopify/ProductVariant/shell-broken-price",
          title: "Everline Rain Shell - Broken",
          price: { amount: "N/A", currency: "USD" },
          availability: { available: true },
          seller: { name: "Everline", url: "https://everline.shop", domain: "everline.shop" },
        },
        // sold out: skipped silently (no warn), never a candidate
        {
          id: "gid://shopify/ProductVariant/shell-sold-out",
          title: "Everline Rain Shell - Sold Out",
          price: { amount: 6400, currency: "USD" },
          availability: { available: false },
          seller: { name: "Everline", url: "https://everline.shop", domain: "everline.shop" },
          checkout_url: "https://everline.shop/cart/shell-sold-out:1",
        },
      ],
    },
    {
      // no product/variant media — candidates may omit imageUrl
      id: "gid://shopify/p/handoff-bomber",
      title: "Boutique Bomber Jacket",
      variants: [
        {
          id: "gid://shopify/ProductVariant/bomber-1",
          title: "Boutique Bomber Jacket - Black / M",
          url: "https://handoff-boutique.com/products/bomber?variant=bomber-1",
          price: { amount: 12000, currency: "USD" },
          availability: { available: true },
          options: [
            { name: "Color", label: "Black" },
            { name: "Size", label: "M" },
          ],
          // domain omitted — normalizer falls back to the seller url hostname
          seller: { name: "Handoff Boutique", url: "https://handoff-boutique.com" },
          checkout_url: "https://handoff-boutique.com/cart/bomber-1:1",
          eligible: { native_checkout: false },
        },
      ],
    },
  ],
};

// Eight valid variants across two products so both the six-candidate cap and
// the one-variant-per-product-first interleaving are observable.
const sneakerSearch: RawCatalogSearchResponse = {
  products: [
    {
      id: "gid://shopify/p/strider",
      title: "Strider Court Sneaker",
      variants: Array.from({ length: 5 }, (_, i) => ({
        id: `gid://shopify/ProductVariant/strider-${i + 1}`,
        title: `Strider Court Sneaker - ${9 + i * 0.5}`,
        url: `https://strider.shop/products/court?variant=strider-${i + 1}`,
        price: { amount: 7000 + i * 100, currency: "USD" },
        availability: { available: true },
        options: [{ name: "Size", label: `${9 + i * 0.5}` }],
        seller: { name: "Strider", url: "https://strider.shop", domain: "strider.shop" },
        checkout_url: `https://strider.shop/cart/strider-${i + 1}:1`,
        eligible: { native_checkout: true },
      })),
    },
    {
      id: "gid://shopify/p/nimbus",
      title: "Nimbus Running Shoe",
      variants: Array.from({ length: 3 }, (_, i) => ({
        id: `gid://shopify/ProductVariant/nimbus-${i + 1}`,
        title: `Nimbus Running Shoe - ${9 + i * 0.5}`,
        url: `https://nimbus.run/products/running?variant=nimbus-${i + 1}`,
        price: { amount: 8850 + i * 100, currency: "USD" },
        availability: { available: true },
        options: [{ name: "Size", label: `${9 + i * 0.5}` }],
        seller: { name: "Nimbus Athletics", url: "https://nimbus.run", domain: "nimbus.run" },
        checkout_url: `https://nimbus.run/cart/nimbus-${i + 1}:1`,
        eligible: { native_checkout: true },
      })),
    },
  ],
};

export function catalogSearchFixture(query: string): RawCatalogSearchResponse {
  const q = query.toLowerCase();
  if (q.includes("sneaker") || q.includes("shoe")) return sneakerSearch;
  return jacketSearch;
}

// Live cart prices per merchant, in integer minor units (real wire format:
// line item price sits on item.price). jacket-black dropped 8900 -> 8500 so
// price-change reporting is observable. Merchants absent from this table have
// no Cart MCP and fall back to handoff.
const cartPrices: Record<string, Record<string, number>> = {
  "aurora-outfitters.com": {
    "gid://shopify/ProductVariant/jacket-black": 8500,
    "gid://shopify/ProductVariant/jacket-navy": 9250,
  },
  "everline.shop": {
    "gid://shopify/ProductVariant/shell-1": 6400,
  },
};

export function cartCreateFixture(
  domain: string,
  lineItems: Array<{ item: { id: string }; quantity: number }>,
): RawCartResponse | null {
  const prices = cartPrices[domain];
  if (!prices) return null;
  return {
    cart: {
      id: `gid://shopify/Cart/${domain}`,
      continue_url: `https://${domain}/checkout/cart-1`,
      currency: "USD",
      line_items: lineItems
        // Variants the merchant no longer sells vanish from the refreshed cart.
        .filter((line) => prices[line.item.id] !== undefined)
        .map((line, i) => ({
          id: `gid://shopify/CartLine/li_${i + 1}`,
          item: { id: line.item.id, title: line.item.id, price: prices[line.item.id] },
          quantity: line.quantity,
          totals: [
            {
              type: "subtotal",
              amount: prices[line.item.id]! * line.quantity,
              display_text: "Subtotal",
            },
          ],
        })),
    },
  };
}
