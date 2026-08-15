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
  it("flattens products x variants into product candidates", async () => {
    const results = await searchCatalog({ query: "black jacket no leather", countryCode: "US" });

    const black = results.find((c) => c.variantId === "gid://shopify/ProductVariant/jacket-black");
    expect(black).toBeDefined();
    expect(black!.productId).toBe("gid://shopify/p/aurora-jacket");
    expect(black!.title).toBe("Aurora Field Jacket - Black / M"); // variant title wins
    expect(black!.sellerName).toBe("Aurora Outfitters");
    expect(black!.sellerDomain).toBe("aurora-outfitters.com");
    expect(black!.currency).toBe("USD");
    expect(black!.selectedOptions).toEqual({ Color: "Black", Size: "M" });
    // variant media wins over product media
    expect(black!.imageUrl).toBe("https://cdn.aurora-outfitters.com/img/field-jacket-black.jpg");
    // checkout_url (cart permalink) is the buy link
    expect(black!.buyUrl).toBe("https://aurora-outfitters.com/cart/jacket-black:1");
  });

  it("falls back to product media and seller-url hostname when the variant omits them", async () => {
    const results = await searchCatalog({ query: "rain jacket", countryCode: "US" });

    const navy = results.find((c) => c.variantId === "gid://shopify/ProductVariant/jacket-navy")!;
    expect(navy.imageUrl).toBe("https://cdn.aurora-outfitters.com/img/field-jacket.jpg");

    const bomber = results.find((c) => c.variantId === "gid://shopify/ProductVariant/bomber-1")!;
    expect(bomber.sellerDomain).toBe("handoff-boutique.com"); // hostname of seller.url
    expect(bomber.imageUrl).toBeUndefined(); // no media anywhere — never invented
  });

  it("keeps wire prices as integer minor units without multiplying", async () => {
    const results = await searchCatalog({ query: "black jacket", countryCode: "US" });

    for (const candidate of results) {
      expect(Number.isInteger(candidate.price)).toBe(true);
    }
    const byId = (id: string) =>
      results.find((c) => c.variantId === `gid://shopify/ProductVariant/${id}`)!;
    expect(byId("jacket-black").price).toBe(8900);
    expect(byId("jacket-navy").price).toBe(9250);
  });

  it("drops malformed variants with a diagnostic and skips sold-out ones silently", async () => {
    const results = await searchCatalog({ query: "rain jacket", countryCode: "US" });

    // breadth-first across products: first variant of each product, then seconds
    const ids = results.map((c) => c.variantId);
    expect(ids).toEqual([
      "gid://shopify/ProductVariant/jacket-black",
      "gid://shopify/ProductVariant/shell-1",
      "gid://shopify/ProductVariant/bomber-1",
      "gid://shopify/ProductVariant/jacket-navy",
    ]);
    // one variant without an id, one with an unparseable price; the sold-out
    // variant is excluded without a warn
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("returns at most six candidates, preferring one variant per product", async () => {
    const results = await searchCatalog({ query: "white sneakers size 9.5", countryCode: "US" });

    expect(results).toHaveLength(6);
    expect(results.map((c) => c.variantId)).toEqual([
      "gid://shopify/ProductVariant/strider-1",
      "gid://shopify/ProductVariant/nimbus-1",
      "gid://shopify/ProductVariant/strider-2",
      "gid://shopify/ProductVariant/nimbus-2",
      "gid://shopify/ProductVariant/strider-3",
      "gid://shopify/ProductVariant/nimbus-3",
    ]);
  });
});

describe("normalizeCatalogSearch", () => {
  const seller = { name: "Sketchy", url: "https://sketchy.example", domain: "sketchy.example" };

  it("drops variants whose only purchase url is not https", () => {
    // javascript:/data: URLs pass zod's .url() but would land in href
    // attributes inside the card webview — they must never survive.
    const results = normalizeCatalogSearch({
      products: [
        {
          id: "gid://shopify/p/sketchy",
          title: "Sketchy Jacket",
          variants: [
            {
              id: "gid://shopify/ProductVariant/sketchy",
              price: { amount: 1000, currency: "USD" },
              availability: { available: true },
              seller,
              checkout_url: "javascript:alert(1)",
            },
          ],
        },
      ],
    });
    expect(results).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("prefers the https variant url when the checkout url is unsafe", () => {
    const results = normalizeCatalogSearch({
      products: [
        {
          id: "gid://shopify/p/sketchy",
          title: "Sketchy Jacket",
          variants: [
            {
              id: "gid://shopify/ProductVariant/sketchy",
              url: "https://sketchy.example/products/jacket?variant=sketchy",
              price: { amount: 1000, currency: "USD" },
              availability: { available: true },
              seller,
              checkout_url: "javascript:alert(1)",
            },
          ],
        },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.buyUrl).toBe("https://sketchy.example/products/jacket?variant=sketchy");
  });

  it("never carries a non-https media url into imageUrl", () => {
    const results = normalizeCatalogSearch({
      products: [
        {
          id: "gid://shopify/p/sketchy",
          title: "Sketchy Jacket",
          media: [{ type: "image", url: "data:text/html,<script>alert(1)</script>" }],
          variants: [
            {
              id: "gid://shopify/ProductVariant/sketchy",
              price: { amount: 1000, currency: "USD" },
              availability: { available: true },
              seller,
              checkout_url: "https://sketchy.example/cart/sketchy:1",
            },
          ],
        },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.imageUrl).toBeUndefined();
  });

  it("requires a seller domain (or url hostname) and a variant id", () => {
    const results = normalizeCatalogSearch({
      products: [
        {
          id: "gid://shopify/p/x",
          title: "No Seller Domain",
          variants: [
            {
              id: "gid://shopify/ProductVariant/x",
              price: { amount: 1000, currency: "USD" },
              availability: { available: true },
              seller: { name: "Ghost" },
              checkout_url: "https://ghost.example/cart/x:1",
            },
          ],
        },
      ],
    });
    expect(results).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
