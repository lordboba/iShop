import { beforeAll, describe, expect, it } from "bun:test";
import type { ProductCandidate } from "../src/domain/mission";
import { CartVariantMissingError, computePriceChanges, createMerchantCarts } from "../src/shopify/cart";

beforeAll(() => {
  process.env.SHOPIFY_FIXTURE_MODE = "1";
  delete process.env.SHOPIFY_CATALOG_CLIENT_ID;
});

function candidate(overrides: Partial<ProductCandidate>): ProductCandidate {
  return {
    productId: "prod-aurora-jacket",
    variantId: "var-jacket-black",
    title: "Aurora Field Jacket",
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
const jacketNavy = candidate({ variantId: "var-jacket-navy", price: 9250 });
const shell = candidate({
  productId: "prod-everline-shell",
  variantId: "var-shell-1",
  title: "Everline Rain Shell",
  sellerName: "Everline",
  sellerDomain: "everline.shop",
  price: 6400,
});
const bomber = candidate({
  productId: "prod-handoff-bomber",
  variantId: "var-bomber-1",
  title: "Boutique Bomber Jacket",
  sellerName: "Handoff Boutique",
  sellerDomain: "handoff-boutique.com",
  price: 12000,
  buyUrl: "https://handoff-boutique.com/buy/var-bomber-1",
});

describe("createMerchantCarts", () => {
  it("groups selections by seller domain with one cart per merchant", async () => {
    const carts = await createMerchantCarts([jacketBlack, shell, jacketNavy], "US");

    expect(carts).toHaveLength(2);
    const aurora = carts.find((c) => c.domain === "aurora-outfitters.com")!;
    const everline = carts.find((c) => c.domain === "everline.shop")!;
    expect(aurora.items.map((i) => i.variantId).sort()).toEqual([
      "var-jacket-black",
      "var-jacket-navy",
    ]);
    expect(everline.items.map((i) => i.variantId)).toEqual(["var-shell-1"]);
    expect(aurora.mode).toBe("cart");
    expect(aurora.continueUrl).toBe("https://aurora-outfitters.com/checkout/cart-1");
  });

  it("reflects live prices and integer subtotals from the refreshed cart", async () => {
    const carts = await createMerchantCarts([jacketBlack, jacketNavy], "US");

    const aurora = carts[0]!;
    const black = aurora.items.find((i) => i.variantId === "var-jacket-black")!;
    expect(black.livePrice).toBe(8500); // fixture cart repriced 8900 -> 8500
    expect(aurora.subtotal).toBe(8500 + 9250);
    expect(Number.isInteger(aurora.subtotal)).toBe(true);
  });

  it("reports price changes without absorbing them silently", async () => {
    const products = [jacketBlack, jacketNavy];
    const carts = await createMerchantCarts(products, "US");

    expect(computePriceChanges(products, carts)).toEqual([
      { variantId: "var-jacket-black", before: 8900, after: 8500 },
    ]);
  });

  it("returns a handoff cart grouping buy urls when the merchant has no Cart MCP", async () => {
    const carts = await createMerchantCarts([bomber], "US");

    expect(carts).toHaveLength(1);
    expect(carts[0]!.mode).toBe("handoff");
    expect(carts[0]!.continueUrl).toBe("https://handoff-boutique.com/buy/var-bomber-1");
    expect(carts[0]!.items[0]!.livePrice).toBe(12000);
    expect(carts[0]!.subtotal).toBe(12000);
  });

  it("refuses a variant missing from the refreshed cart", async () => {
    const discontinued = candidate({ variantId: "var-discontinued" });

    expect(createMerchantCarts([discontinued], "US")).rejects.toThrow(CartVariantMissingError);
  });
});
