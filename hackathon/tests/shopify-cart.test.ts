import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { ProductCandidate } from "../src/domain/mission";
import { CartVariantMissingError, computePriceChanges, createMerchantCarts } from "../src/shopify/cart";
import { McpError } from "../src/shopify/mcp-client";

beforeAll(() => {
  process.env.SHOPIFY_FIXTURE_MODE = "1";
  delete process.env.SHOPIFY_CATALOG_CLIENT_ID;
});

function candidate(overrides: Partial<ProductCandidate>): ProductCandidate {
  return {
    productId: "gid://shopify/p/aurora-jacket",
    variantId: "gid://shopify/ProductVariant/jacket-black",
    title: "Aurora Field Jacket - Black / M",
    sellerName: "Aurora Outfitters",
    sellerDomain: "aurora-outfitters.com",
    price: 8900,
    currency: "USD",
    selectedOptions: {},
    matchedConstraints: [],
    uncertainConstraints: [],
    ...overrides,
  };
}

const jacketBlack = candidate({});
const jacketNavy = candidate({
  variantId: "gid://shopify/ProductVariant/jacket-navy",
  price: 9250,
});
const shell = candidate({
  productId: "gid://shopify/p/everline-shell",
  variantId: "gid://shopify/ProductVariant/shell-1",
  title: "Everline Rain Shell - Black / M",
  sellerName: "Everline",
  sellerDomain: "everline.shop",
  price: 6400,
});
const bomber = candidate({
  productId: "gid://shopify/p/handoff-bomber",
  variantId: "gid://shopify/ProductVariant/bomber-1",
  title: "Boutique Bomber Jacket - Black / M",
  sellerName: "Handoff Boutique",
  sellerDomain: "handoff-boutique.com",
  price: 12000,
  buyUrl: "https://handoff-boutique.com/cart/bomber-1:1",
});

describe("createMerchantCarts", () => {
  it("groups selections by seller domain with one cart per merchant", async () => {
    const carts = await createMerchantCarts([jacketBlack, shell, jacketNavy], "US");

    expect(carts).toHaveLength(2);
    const aurora = carts.find((c) => c.domain === "aurora-outfitters.com")!;
    const everline = carts.find((c) => c.domain === "everline.shop")!;
    expect(aurora.items.map((i) => i.variantId).sort()).toEqual([
      "gid://shopify/ProductVariant/jacket-black",
      "gid://shopify/ProductVariant/jacket-navy",
    ]);
    expect(everline.items.map((i) => i.variantId)).toEqual([
      "gid://shopify/ProductVariant/shell-1",
    ]);
    expect(aurora.mode).toBe("cart");
    expect(aurora.continueUrl).toBe("https://aurora-outfitters.com/checkout/cart-1");
  });

  it("reflects live prices and integer subtotals from the refreshed cart", async () => {
    const carts = await createMerchantCarts([jacketBlack, jacketNavy], "US");

    const aurora = carts[0]!;
    const black = aurora.items.find(
      (i) => i.variantId === "gid://shopify/ProductVariant/jacket-black",
    )!;
    expect(black.livePrice).toBe(8500); // fixture cart repriced 8900 -> 8500
    expect(aurora.subtotal).toBe(8500 + 9250);
    expect(Number.isInteger(aurora.subtotal)).toBe(true);
  });

  it("reports price changes without absorbing them silently", async () => {
    const products = [jacketBlack, jacketNavy];
    const carts = await createMerchantCarts(products, "US");

    expect(computePriceChanges(products, carts)).toEqual([
      {
        variantId: "gid://shopify/ProductVariant/jacket-black",
        before: 8900,
        after: 8500,
      },
    ]);
  });

  it("returns a handoff cart with per-item buy urls when the merchant has no Cart MCP", async () => {
    const carts = await createMerchantCarts([bomber], "US");

    expect(carts).toHaveLength(1);
    expect(carts[0]!.mode).toBe("handoff");
    expect(carts[0]!.continueUrl).toBe("https://handoff-boutique.com");
    expect(carts[0]!.items[0]!.buyUrl).toBe("https://handoff-boutique.com/cart/bomber-1:1");
    expect(carts[0]!.items[0]!.livePrice).toBe(12000);
    expect(carts[0]!.subtotal).toBe(12000);
  });

  it("carries one buy url per item in a multi-item handoff cart", async () => {
    // A single merchant-level link would buy only one item and silently drop
    // the rest — every handoff item must keep its own link.
    const beanie = candidate({
      productId: "gid://shopify/p/handoff-beanie",
      variantId: "gid://shopify/ProductVariant/beanie-1",
      title: "Boutique Beanie",
      sellerName: "Handoff Boutique",
      sellerDomain: "handoff-boutique.com",
      price: 3000,
      buyUrl: "https://handoff-boutique.com/cart/beanie-1:1",
    });

    const carts = await createMerchantCarts([bomber, beanie], "US");

    expect(carts).toHaveLength(1);
    expect(carts[0]!.items.map((i) => i.buyUrl)).toEqual([
      "https://handoff-boutique.com/cart/bomber-1:1",
      "https://handoff-boutique.com/cart/beanie-1:1",
    ]);
    expect(carts[0]!.subtotal).toBe(15000);
  });

  it("drops a non-https buy url instead of carrying it into the card", async () => {
    const sketchy = candidate({
      variantId: "gid://shopify/ProductVariant/sketchy",
      sellerDomain: "handoff-boutique.com",
      buyUrl: "javascript:alert(1)" as string,
    });

    const carts = await createMerchantCarts([sketchy], "US");

    expect(carts[0]!.mode).toBe("handoff");
    expect(carts[0]!.items[0]!.buyUrl).toBeUndefined();
    expect(carts[0]!.continueUrl).toBe("https://handoff-boutique.com");
  });

  it("refuses a variant missing from the refreshed cart", async () => {
    const discontinued = candidate({
      variantId: "gid://shopify/ProductVariant/discontinued",
    });

    expect(createMerchantCarts([discontinued], "US")).rejects.toThrow(CartVariantMissingError);
  });
});

// Live (non-fixture) mode with a stubbed fetch, to exercise the error
// discrimination in fetchCartResponse: only "no Cart MCP" may hand off.
describe("createMerchantCarts cart-MCP failure handling", () => {
  async function inLiveModeWithFetch(
    respond: () => Response,
    run: () => Promise<void>,
  ): Promise<void> {
    const prevFixture = process.env.SHOPIFY_FIXTURE_MODE;
    const prevClient = process.env.SHOPIFY_CATALOG_CLIENT_ID;
    delete process.env.SHOPIFY_FIXTURE_MODE;
    process.env.SHOPIFY_CATALOG_CLIENT_ID = "test-client";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => respond()) as unknown as typeof fetch;
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await run();
    } finally {
      warnSpy.mockRestore();
      globalThis.fetch = originalFetch;
      if (prevFixture === undefined) delete process.env.SHOPIFY_FIXTURE_MODE;
      else process.env.SHOPIFY_FIXTURE_MODE = prevFixture;
      if (prevClient === undefined) delete process.env.SHOPIFY_CATALOG_CLIENT_ID;
      else process.env.SHOPIFY_CATALOG_CLIENT_ID = prevClient;
    }
  }

  it("hands off when the merchant has no Cart MCP (HTTP 404)", async () => {
    await inLiveModeWithFetch(
      () => new Response("not found", { status: 404 }),
      async () => {
        const carts = await createMerchantCarts([jacketBlack], "US");
        expect(carts[0]!.mode).toBe("handoff");
      },
    );
  });

  it("surfaces transient cart failures instead of silently handing off (HTTP 500)", async () => {
    await inLiveModeWithFetch(
      () => new Response("boom", { status: 500 }),
      async () => {
        expect(createMerchantCarts([jacketBlack], "US")).rejects.toThrow(McpError);
      },
    );
  });

  it("refuses a non-https continue_url and hands off instead of linking it", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        structuredContent: {
          cart: {
            id: "gid://shopify/Cart/cart-x",
            continue_url: "javascript:alert(1)",
            currency: "USD",
            line_items: [
              {
                id: "gid://shopify/CartLine/li_1",
                item: {
                  id: "gid://shopify/ProductVariant/jacket-black",
                  title: "Aurora Field Jacket - Black / M",
                  price: 8900,
                },
                quantity: 1,
              },
            ],
          },
        },
      },
    });
    await inLiveModeWithFetch(
      () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      async () => {
        const carts = await createMerchantCarts([jacketBlack], "US");
        expect(carts[0]!.mode).toBe("handoff");
        expect(carts[0]!.continueUrl).toBe("https://aurora-outfitters.com");
      },
    );
  });
});
