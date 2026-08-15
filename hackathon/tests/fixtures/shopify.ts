import type { RawCartResponse, RawCatalogSearchResponse } from "../../src/shopify/types";

// Raw MCP-shaped fixtures (NOT pre-normalized) so fixture mode exercises the
// exact normalization paths used against live Shopify UCP responses.

const jacketSearch: RawCatalogSearchResponse = {
  products: [
    {
      id: "prod-aurora-jacket",
      title: "Aurora Field Jacket",
      image_url: "https://cdn.aurora-outfitters.com/img/field-jacket.jpg",
      seller: { name: "Aurora Outfitters", domain: "aurora-outfitters.com" },
      offers: [
        {
          variant_id: "var-jacket-black",
          price: { amount: "89.00", currency: "USD" },
          selected_options: { Color: "Black", Size: "M" },
          buy_url: "https://aurora-outfitters.com/buy/var-jacket-black",
        },
        {
          variant_id: "var-jacket-navy",
          price: { amount: "92.50", currency: "USD" },
          selected_options: { Color: "Navy", Size: "M" },
          buy_url: "https://aurora-outfitters.com/buy/var-jacket-navy",
        },
      ],
    },
    {
      id: "prod-everline-shell",
      title: "Everline Rain Shell",
      image_url: "https://cdn.everline.shop/img/rain-shell.jpg",
      seller: { name: "Everline", domain: "everline.shop" },
      offers: [
        {
          variant_id: "var-shell-1",
          price: { amount: "64.00", currency: "USD" },
          selected_options: { Color: "Black", Size: "M" },
          buy_url: "https://everline.shop/buy/var-shell-1",
        },
        // malformed: no variant id — must be dropped, not crash
        {
          price: { amount: "58.00", currency: "USD" },
          selected_options: { Color: "Olive", Size: "M" },
        },
        // malformed: unparseable price
        {
          variant_id: "var-shell-broken-price",
          price: { amount: "N/A", currency: "USD" },
        },
      ],
    },
    {
      id: "prod-handoff-bomber",
      title: "Boutique Bomber Jacket",
      seller: { name: "Handoff Boutique", domain: "handoff-boutique.com" },
      offers: [
        {
          variant_id: "var-bomber-1",
          price: { amount: "120.00", currency: "USD" },
          selected_options: { Color: "Black", Size: "M" },
          buy_url: "https://handoff-boutique.com/buy/var-bomber-1",
        },
      ],
    },
  ],
};

// Eight valid offers so the six-candidate cap is observable.
const sneakerSearch: RawCatalogSearchResponse = {
  products: [
    {
      id: "prod-strider",
      title: "Strider Court Sneaker",
      seller: { name: "Strider", domain: "strider.shop" },
      offers: Array.from({ length: 5 }, (_, i) => ({
        variant_id: `var-strider-${i + 1}`,
        price: { amount: `${70 + i}.00`, currency: "USD" },
        selected_options: { Size: `${9 + i * 0.5}` },
        buy_url: `https://strider.shop/buy/var-strider-${i + 1}`,
      })),
    },
    {
      id: "prod-nimbus",
      title: "Nimbus Running Shoe",
      seller: { name: "Nimbus Athletics", domain: "nimbus.run" },
      offers: Array.from({ length: 3 }, (_, i) => ({
        variant_id: `var-nimbus-${i + 1}`,
        price: { amount: `${88 + i}.50`, currency: "USD" },
        selected_options: { Size: `${9 + i * 0.5}` },
        buy_url: `https://nimbus.run/buy/var-nimbus-${i + 1}`,
      })),
    },
  ],
};

export function catalogSearchFixture(query: string): RawCatalogSearchResponse {
  const q = query.toLowerCase();
  if (q.includes("sneaker") || q.includes("shoe")) return sneakerSearch;
  return jacketSearch;
}

// Live cart prices per merchant. var-jacket-black dropped 89.00 -> 85.00 so
// price-change reporting is observable. Merchants absent from this table have
// no Cart MCP and fall back to handoff.
const cartPrices: Record<string, Record<string, string>> = {
  "aurora-outfitters.com": {
    "var-jacket-black": "85.00",
    "var-jacket-navy": "92.50",
  },
  "everline.shop": {
    "var-shell-1": "64.00",
  },
};

export function cartCreateFixture(
  domain: string,
  lineItems: Array<{ item: { id: string }; quantity: number }>,
): RawCartResponse | null {
  const prices = cartPrices[domain];
  if (!prices) return null;
  return {
    id: `cart-${domain}`,
    continue_url: `https://${domain}/checkout/cart-1`,
    line_items: lineItems
      // Variants the merchant no longer sells vanish from the refreshed cart.
      .filter((line) => prices[line.item.id] !== undefined)
      .map((line) => ({
        item: { id: line.item.id, title: line.item.id },
        quantity: line.quantity,
        price: { amount: prices[line.item.id], currency: "USD" },
      })),
  };
}
