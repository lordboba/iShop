// Raw MCP-shaped responses from Shopify UCP tools (verified against the live
// global catalog + the dev.shopify.catalog.global / cart schemas). Fixtures
// reuse these exact shapes so tests exercise the same normalization paths as
// live traffic.

// Prices arrive as INTEGER MINOR UNITS already (34900 = $349.00).
export type RawMoney = { amount?: unknown; currency?: unknown };

export type RawMedia = { type?: unknown; url?: unknown; alt_text?: unknown };

export type RawSeller = {
  id?: unknown;
  name?: unknown;
  url?: unknown; // https storefront url
  domain?: unknown; // myshopify domain
  links?: unknown;
};

export type RawVariant = {
  id?: unknown; // gid://shopify/ProductVariant/...
  title?: unknown;
  description?: unknown;
  url?: unknown; // product page with variant param
  price?: RawMoney;
  availability?: { available?: unknown };
  options?: Array<{ name?: unknown; label?: unknown }>;
  media?: RawMedia[];
  seller?: RawSeller;
  checkout_url?: unknown; // cart permalink, e.g. https://store.com/cart/VARIANTID:1
  rating?: unknown;
  condition?: unknown;
  eligible?: { native_checkout?: unknown };
};

export type RawCatalogProduct = {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  rating?: unknown;
  options?: unknown;
  metadata?: unknown;
  media?: RawMedia[];
  variants?: RawVariant[];
  price_range?: unknown;
};

export type RawCatalogSearchResponse = {
  ucp?: unknown;
  products?: RawCatalogProduct[];
  messages?: unknown;
  pagination?: unknown;
};

// Cart MCP (merchant endpoint https://{domain}/api/ucp/mcp) returns
// structuredContent = { cart: {...} }. Line item price lives on item.price
// as integer minor units.
export type RawCartLineItem = {
  id?: unknown;
  item?: { id?: unknown; title?: unknown; price?: unknown };
  quantity?: unknown;
  totals?: unknown;
};

export type RawCart = {
  id?: unknown;
  continue_url?: unknown;
  line_items?: RawCartLineItem[];
  totals?: unknown;
  currency?: unknown;
  expires_at?: unknown;
};

export type RawCartResponse = {
  cart?: RawCart;
};

// Wire prices are ALREADY integer minor units — never multiply. Accepts an
// integer number or an all-digits string; anything else is unparseable.
export function parseMinorUnits(amount: unknown): number | null {
  if (typeof amount === "number") {
    if (!Number.isInteger(amount) || amount < 0) return null;
    return amount;
  }
  if (typeof amount === "string" && /^\d+$/.test(amount)) {
    return Number(amount);
  }
  return null;
}

export function isFixtureMode(): boolean {
  return (
    process.env.SHOPIFY_FIXTURE_MODE === "1" ||
    !process.env.SHOPIFY_CATALOG_CLIENT_ID
  );
}

export function ucpProfileUrl(): string {
  // Explicit override wins (useful for smoke tests against a known-good
  // conformant profile); otherwise we serve our own from /ucp/profile.
  const override = process.env.SHOPIFY_UCP_PROFILE_URL;
  if (override) return override;
  const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/ucp/profile`;
}
