import { isHttpsUrl, productCandidateSchema, type ProductCandidate } from "../domain/mission";
import { getCatalogAccessToken } from "./auth";
import { callMcpTool } from "./mcp-client";
import {
  isFixtureMode,
  parseMinorUnits,
  ucpProfileUrl,
  type RawCatalogProduct,
  type RawCatalogSearchResponse,
  type RawMedia,
  type RawVariant,
} from "./types";

const MAX_CANDIDATES = 6;

function catalogEndpoint(): string {
  return process.env.SHOPIFY_CATALOG_MCP_URL ?? "https://catalog.shopify.com/api/ucp/mcp";
}

export async function searchCatalog(args: {
  query: string;
  countryCode: string;
  imageUrl?: string;
}): Promise<ProductCandidate[]> {
  const raw = await fetchCatalogResponse(args);
  return normalizeCatalogSearch(raw);
}

async function fetchCatalogResponse(args: {
  query: string;
  countryCode: string;
  imageUrl?: string;
}): Promise<RawCatalogSearchResponse> {
  if (isFixtureMode()) {
    const { catalogSearchFixture } = await import("../../tests/fixtures/shopify");
    return catalogSearchFixture(args.query);
  }

  // Image-similarity search (`catalog.like`) is documented but marked
  // "Planned" (request transition from omit) in the dev.shopify.catalog.global
  // schema, and it takes inline base64 rather than a URL — so we do not send
  // images yet. The text query carries the intent.
  const context = { address_country: args.countryCode };
  const bearerToken = await getCatalogAccessToken();
  const raw = await callMcpTool<RawCatalogSearchResponse>({
    endpoint: catalogEndpoint(),
    tool: "search_catalog",
    // Catalog tool args are namespaced under `catalog` (verified live).
    arguments: { catalog: { query: args.query, context } },
    bearerToken,
    profileUrl: ucpProfileUrl(),
  });
  return enrichProductsMissingVariants(raw, bearerToken);
}

// Search hits normally carry variants inline; when one arrives without them,
// get_product (arguments.catalog.id) fills them in. Enrichment failures leave
// the product variantless so normalization skips it gracefully.
async function enrichProductsMissingVariants(
  raw: RawCatalogSearchResponse,
  bearerToken: string,
): Promise<RawCatalogSearchResponse> {
  const products = await Promise.all(
    (raw.products ?? []).map(async (product) => {
      if (product.variants?.length || typeof product.id !== "string") return product;
      try {
        const detail = await callMcpTool<RawCatalogProduct & { product?: RawCatalogProduct }>({
          endpoint: catalogEndpoint(),
          tool: "get_product",
          arguments: { catalog: { id: product.id } },
          bearerToken,
          profileUrl: ucpProfileUrl(),
        });
        const detailProduct = detail.product ?? detail;
        return { ...product, variants: detailProduct.variants ?? [] };
      } catch {
        return product;
      }
    }),
  );
  return { ...raw, products };
}

// Flattens products×variants into candidates, breadth-first across products
// (one variant per product before seconds; fixture/wire order = relevance),
// capped at MAX_CANDIDATES. Unavailable variants are skipped; malformed ones
// are dropped with a diagnostic. matchedConstraints/uncertainConstraints stay
// [] here — the agent loop/optimizer layer fills them in.
export function normalizeCatalogSearch(raw: RawCatalogSearchResponse): ProductCandidate[] {
  const perProduct = (raw.products ?? []).map((product) =>
    (product.variants ?? [])
      .filter((variant) => variant.availability?.available !== false)
      .map((variant) => normalizeVariant(product, variant))
      .filter((candidate): candidate is ProductCandidate => candidate !== null),
  );

  const candidates: ProductCandidate[] = [];
  const deepest = Math.max(0, ...perProduct.map((list) => list.length));
  for (let rank = 0; rank < deepest; rank++) {
    for (const list of perProduct) {
      const candidate = list[rank];
      if (!candidate) continue;
      candidates.push(candidate);
      if (candidates.length >= MAX_CANDIDATES) return candidates;
    }
  }
  return candidates;
}

function normalizeVariant(product: RawCatalogProduct, variant: RawVariant): ProductCandidate | null {
  const seller = variant.seller;
  const parsed = productCandidateSchema.safeParse({
    productId: product.id,
    variantId: variant.id,
    title: firstString(variant.title, product.title),
    imageUrl: firstHttpsMediaUrl(variant.media, product.media),
    sellerName: seller?.name,
    sellerDomain: firstString(seller?.domain, hostnameOf(seller?.url)),
    // Wire prices are integer minor units already — never multiply.
    price: parseMinorUnits(variant.price?.amount) ?? undefined,
    currency: variant.price?.currency,
    selectedOptions: optionsToRecord(variant.options),
    buyUrl: pickBuyUrl(variant),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    console.warn(
      `shopify catalog: dropped malformed variant (product=${String(product.id ?? "?")}, variant=${String(variant.id ?? "?")}) — ${issues}`,
    );
    return null;
  }
  return parsed.data;
}

// checkout_url (cart permalink) when https, else the variant's product page
// url. A purchase link that exists but is not https must fail schema
// validation and drop the candidate rather than be silently discarded.
function pickBuyUrl(variant: RawVariant): unknown {
  if (typeof variant.checkout_url === "string" && isHttpsUrl(variant.checkout_url)) {
    return variant.checkout_url;
  }
  return variant.url ?? variant.checkout_url ?? undefined;
}

function firstHttpsMediaUrl(...mediaLists: Array<RawMedia[] | undefined>): string | undefined {
  for (const media of mediaLists) {
    for (const entry of media ?? []) {
      if (typeof entry.url === "string" && isHttpsUrl(entry.url)) return entry.url;
    }
  }
  return undefined;
}

function optionsToRecord(options: RawVariant["options"]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const option of options ?? []) {
    if (typeof option?.name === "string" && typeof option?.label === "string") {
      record[option.name] = option.label;
    }
  }
  return record;
}

function firstString(...values: unknown[]): unknown {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return values[0];
}

function hostnameOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
