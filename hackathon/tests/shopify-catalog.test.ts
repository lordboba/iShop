import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { searchCatalog, normalizeCatalogSearch } from "../src/shopify/catalog";

let warnSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  process.env.SHOPIFY_FIXTURE_MODE = "1";
  delete process.env.SHOPIFY_CATALOG_CLIENT_ID;
});

beforeEach(() => {
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("searchCatalog", () => {
  it("normalizes raw MCP responses into product candidates", async () => {
    const results = await searchCatalog({ query: "black jacket no leather", countryCode: "US" });

    const black = results.find((c) => c.variantId === "var-jacket-black");
    expect(black).toBeDefined();
    expect(black!.productId).toBe("prod-aurora-jacket");
    expect(black!.title).toBe("Aurora Field Jacket");
    expect(black!.sellerName).toBe("Aurora Outfitters");
    expect(black!.sellerDomain).toBe("aurora-outfitters.com");
    expect(black!.currency).toBe("USD");
    expect(black!.selectedOptions).toEqual({ Color: "Black", Size: "M" });
    expect(black!.buyUrl).toBe("https://aurora-outfitters.com/buy/var-jacket-black");
  });

  it("keeps prices as integer minor units", async () => {
    const results = await searchCatalog({ query: "black jacket", countryCode: "US" });

    for (const candidate of results) {
      expect(Number.isInteger(candidate.price)).toBe(true);
    }
    expect(results.find((c) => c.variantId === "var-jacket-black")!.price).toBe(8900);
    expect(results.find((c) => c.variantId === "var-jacket-navy")!.price).toBe(9250);
  });

  it("drops malformed offers with a diagnostic instead of throwing", async () => {
    const results = await searchCatalog({ query: "rain jacket", countryCode: "US" });

    const ids = results.map((c) => c.variantId);
    expect(ids).toEqual([
      "var-jacket-black",
      "var-jacket-navy",
      "var-shell-1",
      "var-bomber-1",
    ]);
    // one offer without a variant id, one with an unparseable price
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("returns at most six candidates", async () => {
    const results = await searchCatalog({ query: "white sneakers size 9.5", countryCode: "US" });
    expect(results).toHaveLength(6);
  });
});

describe("normalizeCatalogSearch", () => {
  it("requires seller domain and variant id", () => {
    const results = normalizeCatalogSearch({
      products: [
        {
          id: "prod-x",
          title: "No Seller Domain",
          seller: { name: "Ghost" },
          offers: [{ variant_id: "var-x", price: { amount: "10.00", currency: "USD" } }],
        },
      ],
    });
    expect(results).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
