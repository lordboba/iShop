import { describe, expect, it } from "bun:test";
import type { Message, Space } from "spectrum-ts";
import {
  handleInbound,
  mergeLiveSlotState,
  type AgentLoopDeps,
  type SpaceSession,
} from "../src/agent/loop";
import type { MissionModelClient } from "../src/agent/mission-parser";
import type {
  MissionSlot,
  ProductCandidate,
  ShoppingMission,
} from "../src/domain/mission";
import { MissionStore } from "../src/state/mission-store";

function candidate(
  overrides: Partial<ProductCandidate> = {},
): ProductCandidate {
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
      slots: [
        slot({ candidates: [candidate(), alt], selectedVariantId: "v2" }),
      ],
    });

    const merged = mergeLiveSlotState(parsed, live);

    expect(merged.slots[0]!.selectedVariantId).toBe("v2");
    expect(merged.slots[0]!.candidates).toHaveLength(2);
  });

  it("lets a real spec revision clear an unlocked slot's stale selection", () => {
    // The parser cleared candidates on purpose because the query changed —
    // the live (pre-revision) selection must not resurrect it.
    const parsed = mission({
      slots: [
        slot({
          query: "silk dress",
          candidates: [],
          selectedVariantId: undefined,
        }),
      ],
    });
    const live = mission();

    const merged = mergeLiveSlotState(parsed, live);

    expect(merged.slots[0]!.query).toBe("silk dress");
    expect(merged.slots[0]!.candidates).toHaveLength(0);
    expect(merged.slots[0]!.selectedVariantId).toBeUndefined();
  });

  it("a live lock wins even over a spec revision", () => {
    const parsed = mission({
      slots: [
        slot({
          query: "silk dress",
          candidates: [],
          selectedVariantId: undefined,
        }),
      ],
    });
    const live = mission({ slots: [slot({ locked: true })] });

    const merged = mergeLiveSlotState(parsed, live);

    expect(merged.slots[0]!.locked).toBe(true);
    expect(merged.slots[0]!.query).toBe("linen dress"); // locked slots stay put
    expect(merged.slots[0]!.selectedVariantId).toBe("v1");
  });

  it("passes brand-new slots through untouched", () => {
    const added = slot({
      id: "s-shoes",
      label: "Shoes",
      query: "heels",
      candidates: [],
    });
    const parsed = mission({ slots: [slot(), added] });
    const live = mission();

    const merged = mergeLiveSlotState(parsed, live);

    expect(merged.slots).toHaveLength(2);
    expect(merged.slots[1]!.id).toBe("s-shoes");
  });
});

describe("onboarding conversation", () => {
  it("carries a budget-first draft into the next iMessage turn", async () => {
    const modelCalls: string[] = [];
    const outputs = [
      {
        intent: "create",
        mission: {
          goal: "",
          countryCode: "US",
          budget: { amount: 250, currency: "USD" },
          globalHardConstraints: [],
          globalPreferences: [],
          slots: [
            {
              label: "Clothing",
              query: "clothing",
              required: true,
              hardConstraints: [],
              softPreferences: [],
            },
          ],
        },
        missingFields: ["goal"],
        reply: "What would you like to shop for?",
      },
      {
        intent: "create",
        mission: {
          goal: "Clothes",
          countryCode: "US",
          budget: { amount: 250, currency: "USD" },
          globalHardConstraints: [],
          globalPreferences: [],
          slots: [
            {
              label: "Clothing",
              query: "clothing",
              required: true,
              hardConstraints: [],
              softPreferences: [],
            },
          ],
        },
        missingFields: [],
        reply: null,
      },
    ];
    const client: MissionModelClient = {
      async complete(args) {
        modelCalls.push(args.user);
        return outputs.shift();
      },
    };
    const sent: unknown[] = [];
    const editableMessage = { edit: async () => undefined };
    const space = {
      id: "space-onboarding",
      async send(content: unknown) {
        sent.push(content);
        return editableMessage;
      },
      async responding(run: () => Promise<void>) {
        await run();
      },
    } as unknown as Space;
    const deps: AgentLoopDeps = {
      store: new MissionStore(),
      client,
      searchCatalog: async () => [],
      createMerchantCarts: async () => [],
      publicBaseUrl: "https://shop.example",
    };
    const session: SpaceSession = {};

    await handleInbound(
      space,
      {
        direction: "inbound",
        content: { type: "text", text: "250" },
      } as Message,
      deps,
      session,
    );
    expect(sent[0]).toBe("Got it — $250. What would you like to shop for?");
    await handleInbound(
      space,
      {
        direction: "inbound",
        content: { type: "text", text: "Clothes" },
      } as Message,
      deps,
      session,
    );

    expect(modelCalls[1]).toContain("Current onboarding draft JSON");
    expect(modelCalls[1]).toContain('"amount":250');
    expect(deps.store.getBySpace(space.id)?.goal).toBe("Clothes");
    expect(deps.store.getBySpace(space.id)?.budget.amount).toBe(25000);
    expect(session.draft).toBeUndefined();
    expect(
      sent.filter((item): item is string => typeof item === "string").join(" "),
    ).not.toMatch(/country|currency/i);
  });
});
