import { describe, it, expect } from "bun:test";
import {
  parseMission,
  type MissionModelClient,
} from "../src/agent/mission-parser";
import {
  shoppingMissionSchema,
  type ShoppingMission,
} from "../src/domain/mission";

type ModelOutput = {
  intent: "create" | "revise" | "checkout" | "smalltalk";
  mission: {
    goal: string | null;
    countryCode: string | null;
    budget: { amount: number; currency: string | null } | null;
    globalHardConstraints: string[];
    globalPreferences: string[];
    slots: Array<{
      label: string;
      query: string;
      required: boolean;
      hardConstraints: string[];
      softPreferences: string[];
    }>;
  } | null;
  missingFields: string[];
  reply: string | null;
};

function fakeClient(output: ModelOutput) {
  const calls: Array<{ system: string; user: string; imageUrl?: string }> = [];
  const client: MissionModelClient = {
    async complete(args) {
      calls.push({
        system: args.system,
        user: args.user,
        imageUrl: args.imageUrl,
      });
      return output;
    },
  };
  return { client, calls };
}

type ModelSlot = NonNullable<ModelOutput["mission"]>["slots"][number];

function slot(label: string, overrides: Partial<ModelSlot> = {}): ModelSlot {
  return {
    label,
    query: `${label} for a wedding outfit`,
    required: true,
    hardConstraints: [],
    softPreferences: [],
    ...overrides,
  };
}

const outfitMission: NonNullable<ModelOutput["mission"]> = {
  goal: "Wedding guest outfit",
  countryCode: "US",
  budget: { amount: 400, currency: "USD" },
  globalHardConstraints: [],
  globalPreferences: ["earth tones"],
  slots: [slot("Dress"), slot("Shoes"), slot("Clutch"), slot("Earrings")],
};

describe("parseMission", () => {
  it("decomposes a complete outfit into no more than five purchasable slots", async () => {
    const { client } = fakeClient({
      intent: "create",
      mission: outfitMission,
      missingFields: [],
      reply: null,
    });
    const result = await parseMission(
      { text: "outfit for a June wedding, $400" },
      null,
      client,
    );
    expect(result.intent).toBe("create");
    expect(result.mission).not.toBeNull();
    const mission = result.mission!;
    expect(mission.slots.length).toBeGreaterThanOrEqual(1);
    expect(mission.slots.length).toBeLessThanOrEqual(5);
    // server-assigned stable unique ids
    const ids = mission.slots.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
    expect(() => shoppingMissionSchema.parse(mission)).not.toThrow();
  });

  it("keeps allergy and material exclusions as hard constraints", async () => {
    const { client } = fakeClient({
      intent: "create",
      mission: {
        ...outfitMission,
        slots: [
          slot("Earrings", {
            hardConstraints: ["nickel-free"],
            softPreferences: ["gold tone"],
          }),
          slot("Sweater", { hardConstraints: ["no wool"] }),
        ],
      },
      missingFields: [],
      reply: null,
    });
    const result = await parseMission(
      { text: "earrings and a sweater — nickel allergy, no wool" },
      null,
      client,
    );
    const [earrings, sweater] = result.mission!.slots;
    expect(earrings.hardConstraints).toContain("nickel-free");
    expect(earrings.softPreferences).toContain("gold tone");
    expect(sweater.hardConstraints).toContain("no wool");
  });

  it("converts a dollar budget to integer cents", async () => {
    const { client } = fakeClient({
      intent: "create",
      mission: {
        ...outfitMission,
        budget: { amount: 249.99, currency: "usd" },
      },
      missingFields: [],
      reply: null,
    });
    const result = await parseMission(
      { text: "outfit under $249.99" },
      null,
      client,
    );
    expect(result.mission!.budget.amount).toBe(24999);
    expect(Number.isInteger(result.mission!.budget.amount)).toBe(true);
    expect(result.mission!.budget.currency).toBe("USD");
  });

  it("rejects a mission with no budget instead of inventing one", async () => {
    const { client } = fakeClient({
      intent: "create",
      mission: { ...outfitMission, budget: null },
      missingFields: ["budget"],
      reply: "What's your budget for the outfit?",
    });
    const result = await parseMission(
      { text: "outfit for a June wedding" },
      null,
      client,
    );
    expect(result.mission).toBeNull();
    expect(result.missingFields).toContain("budget");
    expect(result.reply).toBe("What's your budget for the outfit?");
  });

  it("returns a reusable draft when required onboarding data is missing", async () => {
    const { client } = fakeClient({
      intent: "create",
      mission: { ...outfitMission, budget: null },
      missingFields: ["budget"],
      reply: "What's your budget for the outfit?",
    });

    const result = await parseMission(
      { text: "clothes for a wedding" },
      null,
      client,
    );

    expect(result.mission).toBeNull();
    expect(result.draft?.goal).toBe("Wedding guest outfit");
    expect(result.draft?.slots).toHaveLength(4);
  });

  it("includes a budget-first onboarding draft in the next model turn", async () => {
    const first = fakeClient({
      intent: "create",
      mission: {
        ...outfitMission,
        goal: "",
        budget: { amount: 250, currency: "USD" },
        slots: [slot("Clothing", { query: "clothing" })],
      },
      missingFields: ["goal"],
      reply: "What would you like to shop for?",
    });
    const firstResult = await parseMission({ text: "250" }, null, first.client);

    const second = fakeClient({
      intent: "create",
      mission: {
        ...outfitMission,
        goal: "Clothes",
        budget: { amount: 250, currency: "USD" },
        slots: [slot("Clothing", { query: "clothing" })],
      },
      missingFields: [],
      reply: null,
    });
    const secondResult = await parseMission(
      { text: "Clothes" },
      null,
      second.client,
      firstResult.draft,
    );

    expect(second.calls[0]!.user).toContain("Current onboarding draft JSON");
    expect(second.calls[0]!.user).toContain('"amount":250');
    expect(secondResult.mission?.budget.amount).toBe(25000);
  });

  it("does not block on country or currency when the default market is available", async () => {
    const { client } = fakeClient({
      intent: "create",
      mission: {
        ...outfitMission,
        goal: "Clothes",
        countryCode: "US",
        budget: { amount: 250, currency: "USD" },
        slots: [slot("Clothing", { query: "clothing" })],
      },
      missingFields: ["country", "currency"],
      reply: "What country and currency should I use?",
    });

    const result = await parseMission(
      { text: "$250 budget for clothes" },
      null,
      client,
    );

    expect(result.missingFields).toEqual([]);
    expect(result.mission?.countryCode).toBe("US");
    expect(result.mission?.budget.currency).toBe("USD");
  });

  it("normalizes a truly partial budget-only response with market defaults", async () => {
    const { client } = fakeClient({
      intent: "create",
      mission: {
        goal: null,
        countryCode: null,
        budget: { amount: 250, currency: null },
        globalHardConstraints: [],
        globalPreferences: [],
        slots: [],
      },
      missingFields: ["goal"],
      reply: "What would you like to shop for?",
    });

    const result = await parseMission({ text: "250" }, null, client);

    expect(result.mission).toBeNull();
    expect(result.missingFields).toEqual(["goal"]);
    expect(result.draft?.goal).toBeNull();
    expect(result.draft?.countryCode).toBe("US");
    expect(result.draft?.budget).toEqual({ amount: 250, currency: "USD" });
  });

  it("classifies a follow-up message as a revision, not a new mission", async () => {
    const current: ShoppingMission = shoppingMissionSchema.parse({
      id: "mission-1",
      goal: "Wedding guest outfit",
      countryCode: "US",
      budget: { amount: 40000, currency: "USD" },
      globalHardConstraints: [],
      globalPreferences: [],
      slots: [
        {
          id: "slot-dress",
          label: "Dress",
          query: "Dress for a wedding outfit",
          required: true,
          hardConstraints: [],
          softPreferences: [],
          candidates: [],
          locked: true,
        },
        {
          id: "slot-shoes",
          label: "Shoes",
          query: "Shoes for a wedding outfit",
          required: true,
          hardConstraints: [],
          softPreferences: [],
          candidates: [],
          locked: false,
        },
      ],
      status: "ready",
    });
    const { client, calls } = fakeClient({
      intent: "revise",
      mission: {
        ...outfitMission,
        budget: { amount: 400, currency: "USD" },
        slots: [
          slot("Dress"),
          slot("Shoes", {
            query: "cheaper block heel shoes",
            softPreferences: ["under $80"],
          }),
        ],
      },
      missingFields: [],
      reply: null,
    });
    const result = await parseMission(
      { text: "find cheaper shoes" },
      current,
      client,
    );
    expect(result.intent).toBe("revise");
    const mission = result.mission!;
    // same mission, same stable ids — not a new mission
    expect(mission.id).toBe("mission-1");
    expect(mission.slots.find((s) => s.label === "Shoes")!.id).toBe(
      "slot-shoes",
    );
    // locked slot survives untouched
    const dress = mission.slots.find((s) => s.label === "Dress")!;
    expect(dress.locked).toBe(true);
    expect(dress.id).toBe("slot-dress");
    // budget echoed in major units is not double-converted
    expect(mission.budget.amount).toBe(40000);
    // current mission JSON was given to the model for context
    expect(calls[0].user).toContain("Current mission JSON");
    expect(calls[0].user).toContain("Wedding guest outfit");
  });
});
