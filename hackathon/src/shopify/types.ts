// Raw MCP-shaped responses from Shopify UCP tools. Fixtures reuse these exact
// shapes so tests exercise the same normalization paths as live traffic.

export type RawMoney = { amount?: unknown; currency?: unknown };

export type RawOffer = {
  variant_id?: unknown;
  price?: RawMoney;
  selected_options?: Record<string, string>;
  buy_url?: unknown;
};

export type RawCatalogProduct = {
  id?: unknown;
  title?: unknown;
  image_url?: unknown;
  seller?: { name?: unknown; domain?: unknown };
  offers?: RawOffer[];
};

export type RawCatalogSearchResponse = {
  products?: RawCatalogProduct[];
};

export type RawCartLineItem = {
  item?: { id?: unknown; title?: unknown };
  quantity?: unknown;
  price?: RawMoney;
};

export type RawCartResponse = {
  id?: unknown;
  continue_url?: unknown;
  line_items?: RawCartLineItem[];
};

// Money amounts arrive as major-unit decimal strings ("89.99") or numbers.
// Returns integer minor units (8999) or null when unparseable. String parsing
// avoids float rounding drift.
export function toMinorUnits(amount: unknown): number | null {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount < 0) return null;
    return Math.round(amount * 100);
  }
  if (typeof amount === "string") {
    const match = amount.match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!match) return null;
    const whole = Number(match[1]);
    const cents = Number((match[2] ?? "").padEnd(2, "0"));
    return whole * 100 + cents;
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
  const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/ucp/profile`;
}
