import type { CheckoutPlan, MerchantCart, ProductCandidate } from "../domain/mission";
import { callMcpTool } from "./mcp-client";
import { isFixtureMode, toMinorUnits, ucpProfileUrl, type RawCartResponse } from "./types";

// A selected variant that the merchant's refreshed cart no longer contains
// must block checkout — never silently drop a purchase the buyer approved.
export class CartVariantMissingError extends Error {
  constructor(
    public readonly variantId: string,
    domain: string,
  ) {
    super(`variant ${variantId} is missing from the refreshed cart at ${domain}`);
    this.name = "CartVariantMissingError";
  }
}

export async function createMerchantCarts(
  products: ProductCandidate[],
  countryCode: string,
): Promise<MerchantCart[]> {
  const bySeller = new Map<string, ProductCandidate[]>();
  for (const product of products) {
    const group = bySeller.get(product.sellerDomain) ?? [];
    group.push(product);
    bySeller.set(product.sellerDomain, group);
  }

  const carts: MerchantCart[] = [];
  for (const [domain, items] of bySeller) {
    const raw = await fetchCartResponse(domain, items, countryCode);
    // No Cart MCP (or no usable checkout URL) -> buy-link handoff.
    if (!raw || typeof raw.continue_url !== "string") {
      carts.push(handoffCart(domain, items));
    } else {
      carts.push(normalizeCart(domain, items, raw, raw.continue_url));
    }
  }
  return carts;
}

async function fetchCartResponse(
  domain: string,
  items: ProductCandidate[],
  countryCode: string,
): Promise<RawCartResponse | null> {
  const lineItems = items.map((item) => ({ item: { id: item.variantId }, quantity: 1 }));
  if (isFixtureMode()) {
    const { cartCreateFixture } = await import("../../tests/fixtures/shopify");
    return cartCreateFixture(domain, lineItems);
  }
  try {
    return await callMcpTool<RawCartResponse>({
      endpoint: `https://${domain}/api/mcp`,
      tool: "create_cart",
      arguments: { line_items: lineItems, context: { address_country: countryCode } },
      profileUrl: ucpProfileUrl(),
    });
  } catch {
    return null;
  }
}

function normalizeCart(
  domain: string,
  requested: ProductCandidate[],
  raw: RawCartResponse,
  continueUrl: string,
): MerchantCart {
  const lines = raw.line_items ?? [];
  const items = requested.map((product) => {
    const line = lines.find((l) => l.item?.id === product.variantId);
    if (!line) throw new CartVariantMissingError(product.variantId, domain);
    const livePrice = toMinorUnits(line.price?.amount);
    if (livePrice === null) {
      throw new Error(`cart at ${domain} returned an unparseable price for ${product.variantId}`);
    }
    const quantity =
      typeof line.quantity === "number" && Number.isInteger(line.quantity) && line.quantity > 0
        ? line.quantity
        : 1;
    return { variantId: product.variantId, title: product.title, quantity, livePrice };
  });

  return {
    name: requested[0]?.sellerName ?? domain,
    domain,
    items,
    subtotal: items.reduce((sum, item) => sum + item.livePrice * item.quantity, 0),
    continueUrl,
    mode: "cart",
  };
}

function handoffCart(domain: string, items: ProductCandidate[]): MerchantCart {
  return {
    name: items[0]?.sellerName ?? domain,
    domain,
    items: items.map((product) => ({
      variantId: product.variantId,
      title: product.title,
      quantity: 1,
      livePrice: product.price, // no revalidation available in handoff mode
    })),
    subtotal: items.reduce((sum, product) => sum + product.price, 0),
    continueUrl: items.find((product) => product.buyUrl)?.buyUrl ?? `https://${domain}`,
    mode: "handoff",
  };
}

// Diff catalog prices against refreshed cart prices for CheckoutPlan.
export function computePriceChanges(
  products: ProductCandidate[],
  carts: MerchantCart[],
): CheckoutPlan["priceChanges"] {
  const before = new Map(products.map((product) => [product.variantId, product.price]));
  const changes: CheckoutPlan["priceChanges"] = [];
  for (const cart of carts) {
    for (const item of cart.items) {
      const previous = before.get(item.variantId);
      if (previous !== undefined && previous !== item.livePrice) {
        changes.push({ variantId: item.variantId, before: previous, after: item.livePrice });
      }
    }
  }
  return changes;
}
