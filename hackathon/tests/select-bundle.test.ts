import { describe, expect, it } from "bun:test";
import { selectBundle } from "../src/optimizer/select-bundle";
import type {
  MissionSlot,
  ProductCandidate,
  ShoppingMission,
} from "../src/domain/mission";

function candidate(
  over: Partial<ProductCandidate> & { variantId: string; price: number },
): ProductCandidate {
  return {
    productId: `p-${over.variantId}`,
    title: over.variantId,
    sellerName: "Shop",
    sellerDomain: "shop.example.com",
    currency: "USD",
    selectedOptions: {},
    matchedConstraints: [],
    uncertainConstraints: [],
    ...over,
  };
}

function slot(
  id: string,
  candidates: ProductCandidate[],
  over: Partial<MissionSlot> = {},
): MissionSlot {
  return {
    id,
    label: id,
    query: id,
    required: true,
    hardConstraints: [],
    softPreferences: [],
    candidates,
    locked: false,
    ...over,
  };
}

function mission(slots: MissionSlot[], budget = 10000): ShoppingMission {
  return {
    id: "m1",
    goal: "outfit",
    countryCode: "US",
    budget: { amount: budget, currency: "USD" },
    globalHardConstraints: [],
    globalPreferences: [],
    slots,
    status: "ready",
  };
}

describe("selectBundle", () => {
  it("selects one product per required slot without exceeding the total budget", () => {
    const result = selectBundle(
      mission(
        [
          slot("jacket", [
            candidate({ variantId: "j1", price: 6000 }),
            candidate({ variantId: "j2", price: 3000 }),
          ]),
          slot("shoes", [
            candidate({ variantId: "s1", price: 6000 }),
            candidate({ variantId: "s2", price: 3000 }),
          ]),
        ],
        10000,
      ),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(Object.keys(result.selections).sort()).toEqual(["jacket", "shoes"]);
    expect(result.total).toBeLessThanOrEqual(10000);
  });

  it("never selects a candidate with a known hard-constraint violation", () => {
    const result = selectBundle(
      mission([
        slot(
          "jacket",
          [
            // cheaper and more relevant, but "waterproof" is neither matched
            // nor uncertain -> hard violation -> pruned
            candidate({ variantId: "j-bad", price: 1000 }),
            candidate({
              variantId: "j-good",
              price: 5000,
              matchedConstraints: ["waterproof"],
            }),
          ],
          { hardConstraints: ["waterproof"] },
        ),
      ]),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.selections.jacket).toBe("j-good");
  });

  it("allows a candidate whose hard constraint is only uncertain", () => {
    const result = selectBundle(
      mission([
        slot(
          "jacket",
          [
            candidate({
              variantId: "j-maybe",
              price: 2000,
              uncertainConstraints: ["waterproof"],
            }),
          ],
          { hardConstraints: ["waterproof"] },
        ),
      ]),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.selections.jacket).toBe("j-maybe");
  });

  it("preserves locked selections during re-optimization", () => {
    const result = selectBundle(
      mission([
        slot(
          "jacket",
          [
            candidate({ variantId: "j1", price: 1000 }),
            candidate({ variantId: "j2", price: 4000 }),
          ],
          { locked: true, selectedVariantId: "j2" },
        ),
        slot("shoes", [candidate({ variantId: "s1", price: 2000 })]),
      ]),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.selections.jacket).toBe("j2");
    expect(result.total).toBe(6000);
  });

  it("returns infeasible when a locked variant is missing from candidates", () => {
    const result = selectBundle(
      mission([
        slot("jacket", [candidate({ variantId: "j1", price: 1000 })], {
          locked: true,
          selectedVariantId: "gone",
        }),
      ]),
    );
    expect(result.status).toBe("infeasible");
    if (result.status !== "infeasible") return;
    expect(result.blockers.some((b) => b.includes("jacket"))).toBe(true);
  });

  it("prefers fewer merchants when relevance scores are otherwise equal", () => {
    // (j1, s1) is over budget; the two remaining relevance-1 bundles differ
    // only in merchant count, so the single-merchant one must win.
    const result = selectBundle(
      mission(
        [
          slot("jacket", [
            candidate({ variantId: "j1", price: 6000, sellerDomain: "x.com" }),
            candidate({ variantId: "j2", price: 3000, sellerDomain: "z.com" }),
          ]),
          slot("shoes", [
            candidate({ variantId: "s1", price: 6000, sellerDomain: "z.com" }),
            candidate({ variantId: "s2", price: 3000, sellerDomain: "y.com" }),
          ]),
        ],
        10000,
      ),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.selections).toEqual({ jacket: "j2", shoes: "s1" });
    expect(result.merchantCount).toBe(1);
  });

  it("returns an explicit infeasible result instead of dropping a required slot", () => {
    const result = selectBundle(
      mission([
        slot(
          "jacket",
          [candidate({ variantId: "j1", price: 1000 })],
          { hardConstraints: ["waterproof"] }, // no candidate satisfies it
        ),
        slot("shoes", [candidate({ variantId: "s1", price: 2000 })]),
      ]),
    );
    expect(result.status).toBe("infeasible");
    if (result.status !== "infeasible") return;
    expect(result.blockers.some((b) => b.includes("jacket"))).toBe(true);
  });

  it("reports the closest total when every bundle exceeds the budget", () => {
    const result = selectBundle(
      mission([slot("jacket", [candidate({ variantId: "j1", price: 9000 })])], 5000),
    );
    expect(result.status).toBe("infeasible");
    if (result.status !== "infeasible") return;
    expect(result.closestTotal).toBe(9000);
    expect(result.blockers.length).toBeGreaterThan(0);
    // amounts are stored in cents but texted verbatim — must read as dollars
    expect(result.blockers[0]).toContain("90.00 USD");
    expect(result.blockers[0]).toContain("50.00 USD");
  });
});
