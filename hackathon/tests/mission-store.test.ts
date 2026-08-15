import { describe, it, expect } from "bun:test";
import type {
  CheckoutPlan,
  ProductCandidate,
  ShoppingMission,
} from "../src/domain/mission";
import {
  MissionStore,
  reduceMission,
  selectedProducts,
  selectedTotal,
  checkoutBlockers,
} from "../src/state/mission-store";

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    productId: "p1",
    variantId: "v1",
    title: "Linen shirt",
    sellerName: "Acme",
    sellerDomain: "acme.example",
    price: 2500,
    currency: "USD",
    selectedOptions: {},
    matchedConstraints: [],
    uncertainConstraints: [],
    ...overrides,
  };
}

function mission(overrides: Partial<ShoppingMission> = {}): ShoppingMission {
  return {
    id: "m1",
    goal: "summer outfit",
    countryCode: "US",
    budget: { amount: 10000, currency: "USD" },
    globalHardConstraints: [],
    globalPreferences: [],
    status: "searching",
    slots: [
      {
        id: "s1",
        label: "Shirt",
        query: "linen shirt",
        required: true,
        hardConstraints: ["100% linen"],
        softPreferences: ["blue"],
        candidates: [candidate()],
        selectedVariantId: "v1",
        locked: false,
      },
    ],
    ...overrides,
  };
}

describe("reduceMission", () => {
  it("keeps a locked selection when candidates are refreshed", () => {
    const before = mission();
    const locked = reduceMission(before, { type: "slotLocked", slotId: "s1" });
    const refreshed = reduceMission(locked, {
      type: "candidatesLoaded",
      slotId: "s1",
      candidates: [candidate({ productId: "p2", variantId: "v2", price: 3000 })],
    });
    const slot = refreshed.slots[0]!;
    expect(slot.selectedVariantId).toBe("v1");
    // the locked candidate is retained so selectors can still resolve it
    expect(slot.candidates.some((c) => c.variantId === "v1")).toBe(true);
    expect(before.slots[0]!.candidates).toHaveLength(1); // pure: input untouched
  });

  it("clears an unlocked selection when its slot constraints change", () => {
    const revised = reduceMission(mission(), {
      type: "slotRevised",
      slotId: "s1",
      query: "cotton shirt",
      hardConstraints: ["100% cotton"],
      softPreferences: [],
    });
    const slot = revised.slots[0]!;
    expect(slot.selectedVariantId).toBeUndefined();
    expect(slot.candidates).toHaveLength(0);
    expect(slot.query).toBe("cotton shirt");
    expect(slot.hardConstraints).toEqual(["100% cotton"]);
  });

  it("recomputes the total from selected product prices", () => {
    const m = mission({
      slots: [
        mission().slots[0]!,
        {
          id: "s2",
          label: "Shorts",
          query: "linen shorts",
          required: true,
          hardConstraints: [],
          softPreferences: [],
          candidates: [candidate({ productId: "p2", variantId: "v2", price: 4200 })],
          selectedVariantId: "v2",
          locked: false,
        },
        {
          id: "s3",
          label: "Hat",
          query: "sun hat",
          required: false,
          hardConstraints: [],
          softPreferences: [],
          candidates: [candidate({ productId: "p3", variantId: "v3", price: 999 })],
          locked: false, // no selection: must not count toward total
        },
      ],
    });
    expect(selectedTotal(m)).toBe(2500 + 4200);
    expect(selectedProducts(m).map((c) => c.variantId)).toEqual(["v1", "v2"]);
  });

  it("blocks checkout when a required slot has no valid selection", () => {
    const m = mission();
    const unselected = reduceMission(m, {
      type: "slotRevised",
      slotId: "s1",
      query: "linen shirt",
      hardConstraints: [],
      softPreferences: [],
    });
    const blockers = checkoutBlockers(unselected);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("Shirt");
    expect(checkoutBlockers(m)).toEqual([]);
  });

  it("blocks checkout when the selected total exceeds the hard budget", () => {
    const m = mission({ budget: { amount: 2000, currency: "USD" } });
    const blockers = checkoutBlockers(m);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("budget");
    // amounts are stored in cents but texted verbatim — must read as dollars
    expect(blockers[0]).toContain("25.00 USD");
    expect(blockers[0]).toContain("20.00 USD");
  });
});

describe("reduceMission edges", () => {
  it("drops an unlocked selection whose variant vanished from refreshed candidates", () => {
    const refreshed = reduceMission(mission(), {
      type: "candidatesLoaded",
      slotId: "s1",
      candidates: [candidate({ productId: "p9", variantId: "v9" })],
    });
    expect(refreshed.slots[0]!.selectedVariantId).toBeUndefined();
  });

  it("refuses to lock a slot that has no selected candidate", () => {
    // A locked-but-empty slot would dead-end: the optimizer skips the lock
    // while the reducer refuses selections. Locking must require a selection.
    const unselected = reduceMission(mission(), {
      type: "slotRevised",
      slotId: "s1",
      query: "cotton shirt",
      hardConstraints: [],
      softPreferences: [],
    });
    const locked = reduceMission(unselected, { type: "slotLocked", slotId: "s1" });
    expect(locked.slots[0]!.locked).toBe(false);
  });

  it("ignores candidateSelected on a locked slot and unknown variants", () => {
    const locked = reduceMission(mission(), { type: "slotLocked", slotId: "s1" });
    const afterLockedSelect = reduceMission(locked, {
      type: "candidateSelected",
      slotId: "s1",
      variantId: "v1",
    });
    expect(afterLockedSelect.slots[0]!.selectedVariantId).toBe("v1");
    const afterUnknown = reduceMission(mission(), {
      type: "candidateSelected",
      slotId: "s1",
      variantId: "missing",
    });
    expect(afterUnknown.slots[0]!.selectedVariantId).toBe("v1");
  });

  it("moves status through searching and checkout", () => {
    const draft = mission({ status: "draft" });
    const searching = reduceMission(draft, { type: "searchStarted", slotIds: ["s1"] });
    expect(searching.status).toBe("searching");
    const ready = reduceMission(searching, {
      type: "candidatesLoaded",
      slotId: "s1",
      candidates: [candidate()],
    });
    expect(ready.status).toBe("ready");
    expect(reduceMission(ready, { type: "checkoutStarted" }).status).toBe("checkout");
  });
});

describe("MissionStore", () => {
  it("stores one mission per space, addressable by mission id", () => {
    const store = new MissionStore();
    expect(store.getBySpace("space-1")).toBeNull();
    expect(() => store.dispatch("space-1", { type: "checkoutStarted" })).toThrow();

    store.put("space-1", mission());
    expect(store.getBySpace("space-1")?.id).toBe("m1");
    expect(store.getByMissionId("m1")?.id).toBe("m1");
    expect(store.spaceIdForMission("m1")).toBe("space-1");

    const next = store.dispatch("space-1", { type: "slotLocked", slotId: "s1" });
    expect(next.slots[0]!.locked).toBe(true);
    expect(store.getBySpace("space-1")).toBe(next);
  });

  it("replaces the old mission when a new brief arrives in the same space", () => {
    const store = new MissionStore();
    store.put("space-1", mission());
    store.putCheckoutPlan("m1", {
      merchants: [],
      previousTotal: 0,
      liveTotal: 0,
      priceChanges: [],
    });
    store.put("space-1", mission({ id: "m2" }));
    expect(store.getByMissionId("m1")).toBeNull();
    expect(store.getCheckoutPlan("m1")).toBeNull();
    expect(store.getByMissionId("m2")?.id).toBe("m2");
  });

  it("round-trips a checkout plan by mission id", () => {
    const store = new MissionStore();
    store.put("space-1", mission());
    expect(store.getCheckoutPlan("m1")).toBeNull();
    const plan: CheckoutPlan = {
      merchants: [
        {
          name: "Acme",
          domain: "acme.example",
          items: [{ variantId: "v1", title: "Linen shirt", quantity: 1, livePrice: 2600 }],
          subtotal: 2600,
          continueUrl: "https://acme.example/cart/abc",
          mode: "cart",
        },
      ],
      previousTotal: 2500,
      liveTotal: 2600,
      priceChanges: [{ variantId: "v1", before: 2500, after: 2600 }],
    };
    store.putCheckoutPlan("m1", plan);
    expect(store.getCheckoutPlan("m1")).toEqual(plan);
  });
});
