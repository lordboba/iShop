import { describe, expect, it } from "bun:test";
import { mergeLiveSlotState } from "../src/agent/loop";
import type {
  MissionSlot,
  ProductCandidate,
  ShoppingMission,
} from "../src/domain/mission";

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    productId: "p1",
    variantId: "v1",
    title: "Linen dress",
    sellerName: "Acme",
    sellerDomain: "acme.example",
    price: 5200,
    currency: "USD",
    selectedOptions: {},
    matchedConstraints: [],
    uncertainConstraints: [],
    ...overrides,
  };
}

function slot(overrides: Partial<MissionSlot> = {}): MissionSlot {
  return {
    id: "s-dress",
    label: "Dress",
    query: "linen dress",
    required: true,
    hardConstraints: [],
    softPreferences: [],
    candidates: [candidate()],
    selectedVariantId: "v1",
    locked: false,
    ...overrides,
  };
}

function mission(overrides: Partial<ShoppingMission> = {}): ShoppingMission {
  return {
    id: "m1",
    goal: "wedding guest outfit",
    countryCode: "US",
    budget: { amount: 40000, currency: "USD" },
    globalHardConstraints: [],
    globalPreferences: [],
    slots: [slot()],
    status: "ready",
    ...overrides,
  };
}

// The parse model call takes seconds; card actions (lock/select) land on the
// shared store meanwhile. The parsed mission is built from a pre-parse
// snapshot, so the merge must re-apply live slot state before put().
describe("mergeLiveSlotState", () => {
  it("keeps a lock that landed on the card while the model was parsing", () => {
    const parsed = mission(); // stale snapshot: unlocked
    const live = mission({ slots: [slot({ locked: true })] }); // user tapped Lock

    const merged = mergeLiveSlotState(parsed, live);

    expect(merged.slots[0]!.locked).toBe(true);
    expect(merged.slots[0]!.selectedVariantId).toBe("v1");
  });

  it("keeps a selection change made on the card during the parse", () => {
    const alt = candidate({ variantId: "v2", price: 6100 });
    const parsed = mission();
    const live = mission({
      slots: [slot({ candidates: [candidate(), alt], selectedVariantId: "v2" })],
    });

    const merged = mergeLiveSlotState(parsed, live);

    expect(merged.slots[0]!.selectedVariantId).toBe("v2");
    expect(merged.slots[0]!.candidates).toHaveLength(2);
  });

  it("lets a real spec revision clear an unlocked slot's stale selection", () => {
    // The parser cleared candidates on purpose because the query changed —
    // the live (pre-revision) selection must not resurrect it.
    const parsed = mission({
      slots: [slot({ query: "silk dress", candidates: [], selectedVariantId: undefined })],
    });
    const live = mission();

    const merged = mergeLiveSlotState(parsed, live);

    expect(merged.slots[0]!.query).toBe("silk dress");
    expect(merged.slots[0]!.candidates).toHaveLength(0);
    expect(merged.slots[0]!.selectedVariantId).toBeUndefined();
  });

  it("a live lock wins even over a spec revision", () => {
    const parsed = mission({
      slots: [slot({ query: "silk dress", candidates: [], selectedVariantId: undefined })],
    });
    const live = mission({ slots: [slot({ locked: true })] });

    const merged = mergeLiveSlotState(parsed, live);

    expect(merged.slots[0]!.locked).toBe(true);
    expect(merged.slots[0]!.query).toBe("linen dress"); // locked slots stay put
    expect(merged.slots[0]!.selectedVariantId).toBe("v1");
  });

  it("passes brand-new slots through untouched", () => {
    const added = slot({ id: "s-shoes", label: "Shoes", query: "heels", candidates: [] });
    const parsed = mission({ slots: [slot(), added] });
    const live = mission();

    const merged = mergeLiveSlotState(parsed, live);

    expect(merged.slots).toHaveLength(2);
    expect(merged.slots[1]!.id).toBe("s-shoes");
  });
});
