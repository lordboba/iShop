import { productCandidateSchema, type ProductCandidate } from "../domain/mission";
import { getCatalogAccessToken } from "./auth";
import { callMcpTool } from "./mcp-client";
import {
  isFixtureMode,
  toMinorUnits,
  ucpProfileUrl,
  type RawCatalogProduct,
  type RawCatalogSearchResponse,
  type RawOffer,
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

  const bearerToken = await getCatalogAccessToken();
  const context = { address_country: args.countryCode };
  const raw = await callMcpTool<RawCatalogSearchResponse>({
    endpoint: catalogEndpoint(),
    tool: "search_catalog",
    arguments: {
      query: args.query,
      context,
      ...(args.imageUrl ? { image_url: args.imageUrl } : {}),
    },
    bearerToken,
    profileUrl: ucpProfileUrl(),
  });
  return enrichProductsMissingOffers(raw, context, bearerToken);
}

// Some search hits omit variant offers; get_product fills them in. Enrichment
// failures leave the product offerless so normalization drops it gracefully.
async function enrichProductsMissingOffers(
  raw: RawCatalogSearchResponse,
  context: { address_country: string },
  bearerToken: string,
): Promise<RawCatalogSearchResponse> {
  const products = await Promise.all(
    (raw.products ?? []).map(async (product) => {
      if (product.offers?.length || typeof product.id !== "string") return product;
      try {
        const detail = await callMcpTool<RawCatalogProduct>({
          endpoint: catalogEndpoint(),
          tool: "get_product",
          arguments: { id: product.id, context },
          bearerToken,
          profileUrl: ucpProfileUrl(),
        });
        return { ...product, offers: detail.offers ?? [] };
      } catch {
        return product;
      }
    }),
  );
  return { products };
}

export function normalizeCatalogSearch(raw: RawCatalogSearchResponse): ProductCandidate[] {
  const candidates: ProductCandidate[] = [];
  for (const product of raw.products ?? []) {
    for (const offer of product.offers ?? []) {
      if (candidates.length >= MAX_CANDIDATES) return candidates;
      const candidate = normalizeOffer(product, offer);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function normalizeOffer(product: RawCatalogProduct, offer: RawOffer): ProductCandidate | null {
  const price = toMinorUnits(offer.price?.amount);
  const parsed = productCandidateSchema.safeParse({
    productId: product.id,
    variantId: offer.variant_id,
    title: product.title,
    imageUrl: product.image_url ?? undefined,
    sellerName: product.seller?.name,
    sellerDomain: product.seller?.domain,
    price: price ?? undefined,
    currency: offer.price?.currency,
    selectedOptions: offer.selected_options ?? {},
    buyUrl: offer.buy_url ?? undefined,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    console.warn(
      `shopify catalog: dropped malformed offer (product=${String(product.id ?? "?")}, variant=${String(offer.variant_id ?? "?")}) — ${issues}`,
    );
    return null;
  }
  return parsed.data;
}
