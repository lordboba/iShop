import { isHttpsUrl, type CheckoutPlan, type MerchantCart, type ProductCandidate } from "../domain/mission";
import { callMcpTool, McpError } from "./mcp-client";
import {
  isFixtureMode,
  parseMinorUnits,
  ucpProfileUrl,
  type RawCart,
  type RawCartResponse,
} from "./types";

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
    // No Cart MCP (or no usable https checkout URL — merchant data must never
    // put a javascript:/data: link behind the checkout button) -> handoff.
    // Variants ineligible for native checkout land here too: their merchants
    // don't serve a Cart MCP, and each item keeps its checkout_url buy link.
    if (!raw || typeof raw.continue_url !== "string" || !isHttpsUrl(raw.continue_url)) {
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
): Promise<RawCart | null> {
  const lineItems = items.map((item) => ({ item: { id: item.variantId }, quantity: 1 }));
  if (isFixtureMode()) {
    const { cartCreateFixture } = await import("../../tests/fixtures/shopify");
    return cartCreateFixture(domain, lineItems)?.cart ?? null;
  }
  try {
    const response = await callMcpTool<RawCartResponse>({
      // Merchant Cart MCP endpoint (per shopify.dev cart-mcp docs).
      endpoint: `https://${domain}/api/ucp/mcp`,
      tool: "create_cart",
      // Cart tool args are namespaced under `cart`, same meta-inside-arguments
      // pattern as the catalog (meta is injected by callMcpTool).
      arguments: {
        cart: { line_items: lineItems, context: { address_country: countryCode } },
      },
      profileUrl: ucpProfileUrl(),
    });
    return response.cart ?? null;
  } catch (error) {
    // Only "this merchant has no Cart MCP" (HTTP 404/405, JSON-RPC method not
    // found) may degrade to handoff. Timeouts, 5xx, and transport failures
    // must surface so the buyer is told to retry instead of being shown stale
    // prices as live-verified.
    if (
      error instanceof McpError &&
      (error.code === 404 || error.code === 405 || error.code === -32601)
    ) {
      console.warn(`[cart] ${domain} has no Cart MCP (code ${error.code}) — buy-link handoff`);
      return null;
    }
    throw error;
  }
}

function normalizeCart(
  domain: string,
  requested: ProductCandidate[],
  raw: RawCart,
  continueUrl: string,
): MerchantCart {
  const lines = raw.line_items ?? [];
  const items = requested.map((product) => {
    const line = lines.find((l) => l.item?.id === product.variantId);
    if (!line) throw new CartVariantMissingError(product.variantId, domain);
    // Live price lives on item.price as integer minor units.
    const livePrice = parseMinorUnits(line.item?.price);
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
      buyUrl: product.buyUrl && isHttpsUrl(product.buyUrl) ? product.buyUrl : undefined,
    })),
    subtotal: items.reduce((sum, product) => sum + product.price, 0),
    continueUrl: combinedCartPermalink(domain, items) ?? `https://${domain}`,
    mode: "handoff",
  };
}

// Shopify cart permalinks accept multiple items: /cart/ID1:QTY,ID2:QTY.
// Combining lets one tap add a merchant's whole share of the bundle, instead
// of one link per item. Falls back to null (bare-domain continueUrl) when any
// item's numeric variant id can't be derived.
function combinedCartPermalink(domain: string, items: ProductCandidate[]): string | null {
  const segments: string[] = [];
  let origin: string | null = null;
  for (const product of items) {
    let segment: string | null = null;
    if (product.buyUrl && isHttpsUrl(product.buyUrl)) {
      const url = new URL(product.buyUrl);
      const match = url.pathname.match(/^\/cart\/(\d+:\d+)$/);
      if (match?.[1]) {
        segment = match[1];
        origin ??= url.origin; // prefer the merchant's own checkout origin
      }
    }
    if (!segment) {
      // Strict full-numeric gid only — a partial numeric tail of a
      // non-numeric id would build a permalink for the WRONG product.
      const numericId = product.variantId.match(
        /^gid:\/\/shopify\/ProductVariant\/(\d+)$/,
      )?.[1];
      segment = numericId ? `${numericId}:1` : null;
    }
    if (!segment) return null;
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  return `${origin ?? `https://${domain}`}/cart/${segments.join(",")}`;
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
