import { describe, expect, it } from "bun:test";
import { buildCheckoutPlan, CheckoutBlockedError } from "../src/agent/checkout";
import type {
  MerchantCart,
  MissionSlot,
  ProductCandidate,
  ShoppingMission,
} from "../src/domain/mission";
import type { createMerchantCarts } from "../src/shopify/cart";

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    productId: "prod-jacket",
    variantId: "var-jacket",
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

function slot(overrides: Partial<MissionSlot> = {}): MissionSlot {
  return {
    id: "slot-jacket",
    label: "jacket",
    query: "black field jacket",
    required: true,
    hardConstraints: [],
    softPreferences: [],
    candidates: [],
    locked: false,
    ...overrides,
  };
}

function mission(overrides: Partial<ShoppingMission> = {}): ShoppingMission {
  return {
    id: "mission-1",
    goal: "rooftop dinner outfit",
    countryCode: "US",
    budget: { amount: 25_000, currency: "USD" },
    globalHardConstraints: [],
    globalPreferences: [],
    slots: [slot()],
    status: "ready",
    ...overrides,
  };
}

const jacket = candidate({});
const shoes = candidate({
  productId: "prod-shoes",
  variantId: "var-shoes",
  title: "Everline Derby Shoes",
  sellerName: "Everline",
  sellerDomain: "everline.shop",
  price: 6400,
});

function readyMission(overrides: Partial<ShoppingMission> = {}): ShoppingMission {
  return mission({
    slots: [
      slot({ candidates: [jacket], selectedVariantId: jacket.variantId }),
      slot({
        id: "slot-shoes",
        label: "shoes",
        query: "black derby shoes",
        candidates: [shoes],
        selectedVariantId: shoes.variantId,
      }),
    ],
    ...overrides,
  });
}

// Injected fake cart adapter: echoes requested products back as one cart per
// seller (like the real adapter), with optional live repricing / dropped
// variants, and records every call so tests can assert revalidation happened.
function fakeCartAdapter(opts: { reprice?: Record<string, number>; drop?: string[] } = {}) {
  const calls: Array<{ products: ProductCandidate[]; countryCode: string }> = [];
  const fn: typeof createMerchantCarts = async (products, countryCode) => {
    calls.push({ products, countryCode });
    const bySeller = new Map<string, ProductCandidate[]>();
    for (const product of products) {
      bySeller.set(product.sellerDomain, [...(bySeller.get(product.sellerDomain) ?? []), product]);
    }
    const carts: MerchantCart[] = [];
    for (const [domain, group] of bySeller) {
      const items = group
        .filter((product) => !opts.drop?.includes(product.variantId))
        .map((product) => ({
          variantId: product.variantId,
          title: product.title,
          quantity: 1,
          livePrice: opts.reprice?.[product.variantId] ?? product.price,
        }));
      carts.push({
        name: group[0]!.sellerName,
        domain,
        items,
        subtotal: items.reduce((sum, item) => sum + item.livePrice, 0),
        continueUrl: `https://${domain}/checkout/live`,
        mode: "cart",
      });
    }
    return carts;
  };
  return { fn, calls };
}

describe("buildCheckoutPlan", () => {
  it("throws a typed error listing every blocker and never touches merchant carts", async () => {
    const fake = fakeCartAdapter();
    // Two independent blockers: an over-budget selection and an unfilled required slot.
    const expensive = candidate({ variantId: "var-pricey", price: 30_000 });
    const blocked = mission({
      slots: [
        slot({ candidates: [expensive], selectedVariantId: expensive.variantId }),
        slot({ id: "slot-shoes", label: "shoes", required: true }),
      ],
    });

    const error = await buildCheckoutPlan(blocked, { createMerchantCarts: fake.fn }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(CheckoutBlockedError);
    const blockers = (error as CheckoutBlockedError).blockers;
    expect(blockers).toHaveLength(2);
    expect(blockers.join(" ")).toContain("shoes");
    expect(blockers.join(" ")).toContain("budget");
    expect(fake.calls).toHaveLength(0);
  });

  it("never derives approval from model output: a model-authored checkout status still blocks", async () => {
    const fake = fakeCartAdapter();
    // As if a model claimed the mission was checkout-approved — required slot is still empty.
    const claimed = mission({ status: "checkout", slots: [slot()] });

    expect(buildCheckoutPlan(claimed, { createMerchantCarts: fake.fn })).rejects.toThrow(
      CheckoutBlockedError,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("revalidates every selected variant against live cart responses", async () => {
    const fake = fakeCartAdapter();

    const plan = await buildCheckoutPlan(readyMission(), { createMerchantCarts: fake.fn });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.countryCode).toBe("US");
    expect(fake.calls[0]!.products.map((p) => p.variantId).sort()).toEqual([
      "var-jacket",
      "var-shoes",
    ]);
    const liveVariants = plan.merchants.flatMap((m) => m.items.map((i) => i.variantId)).sort();
    expect(liveVariants).toEqual(["var-jacket", "var-shoes"]);
  });

  it("computes previousTotal from selections, liveTotal from live prices, and reports every change", async () => {
    const fake = fakeCartAdapter({ reprice: { "var-jacket": 8500 } });

    const plan = await buildCheckoutPlan(readyMission(), { createMerchantCarts: fake.fn });

    expect(plan.previousTotal).toBe(8900 + 6400);
    expect(plan.liveTotal).toBe(8500 + 6400);
    expect(plan.priceChanges).toEqual([
      { variantId: "var-jacket", before: 8900, after: 8500 },
    ]);
  });

  it("reports no price changes when live prices match the selections", async () => {
    const fake = fakeCartAdapter();

    const plan = await buildCheckoutPlan(readyMission(), { createMerchantCarts: fake.fn });

    expect(plan.priceChanges).toEqual([]);
    expect(plan.liveTotal).toBe(plan.previousTotal);
  });

  it("refuses the plan when a selected variant is missing from the refreshed carts", async () => {
    const fake = fakeCartAdapter({ drop: ["var-shoes"] });

    const error = await buildCheckoutPlan(readyMission(), { createMerchantCarts: fake.fn }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(CheckoutBlockedError);
    expect((error as CheckoutBlockedError).blockers.join(" ")).toContain("var-shoes");
  });
});
