import { z } from "zod";
import OpenAI from "openai";
import {
  shoppingMissionSchema,
  type MissionSlot,
  type ShoppingMission,
} from "../domain/mission";
import { MISSION_SYSTEM_PROMPT } from "./prompts";

export interface MissionModelClient {
  // returns JSON matching the provided JSON schema (already parsed)
  complete(args: {
    system: string;
    user: string;
    imageUrl?: string;
    schema: Record<string, unknown>;
  }): Promise<unknown>;
}

export type ParseResult = {
  intent: "create" | "revise" | "checkout" | "smalltalk";
  mission: ShoppingMission | null;
  draft: MissionDraft | null;
  missingFields: string[];
  reply?: string;
};

// Model-facing shape: no ids (assigned server-side), budget in major units.
// All fields required/nullable so the JSON schema works in strict mode.
const modelSlotSchema = z.object({
  label: z.string(),
  query: z.string(),
  required: z.boolean(),
  hardConstraints: z.array(z.string()),
  softPreferences: z.array(z.string()),
});

const modelMissionSchema = z.object({
  goal: z.string().nullable(),
  countryCode: z.string().length(2).nullable(),
  budget: z
    .object({
      amount: z.number().positive(),
      currency: z.string().length(3).nullable(),
    })
    .nullable(),
  globalHardConstraints: z.array(z.string()),
  globalPreferences: z.array(z.string()),
  slots: z.array(modelSlotSchema).max(5),
});

type ModelMissionDraft = z.infer<typeof modelMissionSchema>;

export type MissionDraft = {
  goal: string | null;
  countryCode: string;
  budget: { amount: number; currency: string } | null;
  globalHardConstraints: string[];
  globalPreferences: string[];
  slots: Array<z.infer<typeof modelSlotSchema>>;
};

const modelOutputSchema = z.object({
  intent: z.enum(["create", "revise", "checkout", "smalltalk"]),
  mission: modelMissionSchema.nullable(),
  missingFields: z.array(z.string()),
  reply: z.string().nullable(),
});

const missionParseJsonSchema = z.toJSONSchema(modelOutputSchema) as Record<
  string,
  unknown
>;

export function createOpenAIMissionClient(): MissionModelClient {
  let openai: OpenAI | null = null; // lazy: importing without OPENAI_API_KEY never throws
  return {
    async complete({ system, user, imageUrl, schema }) {
      openai ??= new OpenAI();
      const content: OpenAI.Responses.ResponseInputContent[] = [
        { type: "input_text", text: user },
      ];
      if (imageUrl)
        content.push({
          type: "input_image",
          image_url: imageUrl,
          detail: "auto",
        });
      const response = await openai.responses.create({
        model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
        reasoning: { effort: "low" },
        input: [
          { role: "system", content: system },
          { role: "user", content },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "mission_parse",
            schema,
            strict: true,
          },
        },
      });
      return JSON.parse(response.output_text);
    },
  };
}

// Budget shown to the model in major units so its echo never gets re-converted.
function missionForModel(mission: ShoppingMission) {
  return {
    goal: mission.goal,
    countryCode: mission.countryCode,
    budget: {
      amount: mission.budget.amount / 100,
      currency: mission.budget.currency,
    },
    globalHardConstraints: mission.globalHardConstraints,
    globalPreferences: mission.globalPreferences,
    slots: mission.slots.map((s) => ({
      label: s.label,
      query: s.query,
      required: s.required,
      hardConstraints: s.hardConstraints,
      softPreferences: s.softPreferences,
      locked: s.locked,
    })),
  };
}

function sameSlotSpec(
  a: MissionSlot,
  b: z.infer<typeof modelSlotSchema>,
): boolean {
  return (
    a.query === b.query &&
    JSON.stringify(a.hardConstraints) === JSON.stringify(b.hardConstraints) &&
    JSON.stringify(a.softPreferences) === JSON.stringify(b.softPreferences)
  );
}

function normalizeDraft(
  model: ModelMissionDraft,
  current: MissionDraft | null,
): MissionDraft {
  const goal = model.goal?.trim() || current?.goal || null;
  const countryCode =
    model.countryCode?.toUpperCase() ?? current?.countryCode ?? "US";
  const budget = model.budget
    ? {
        amount: model.budget.amount,
        currency:
          model.budget.currency?.toUpperCase() ??
          current?.budget?.currency ??
          "USD",
      }
    : (current?.budget ?? null);
  const slots =
    model.slots.length > 0
      ? model.slots
      : current?.slots.length
        ? current.slots
        : goal
          ? [
              {
                label: goal,
                query: goal,
                required: true,
                hardConstraints: [],
                softPreferences: [],
              },
            ]
          : [];

  return {
    goal,
    countryCode,
    budget,
    globalHardConstraints:
      model.globalHardConstraints.length > 0
        ? model.globalHardConstraints
        : (current?.globalHardConstraints ?? []),
    globalPreferences:
      model.globalPreferences.length > 0
        ? model.globalPreferences
        : (current?.globalPreferences ?? []),
    slots,
  };
}

export async function parseMission(
  input: { text: string; imageUrl?: string },
  current: ShoppingMission | null,
  client: MissionModelClient,
  currentDraft: MissionDraft | null = null,
): Promise<ParseResult> {
  const user = current
    ? `${input.text}\n\nCurrent mission JSON:\n${JSON.stringify(missionForModel(current))}`
    : currentDraft
      ? `${input.text}\n\nCurrent onboarding draft JSON:\n${JSON.stringify(currentDraft)}`
      : input.text;

  const raw = await client.complete({
    system: MISSION_SYSTEM_PROMPT,
    user,
    imageUrl: input.imageUrl,
    schema: missionParseJsonSchema,
  });

  const parsed = modelOutputSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error("mission model output failed schema validation");
  const out = parsed.data;
  const reply = out.reply ?? undefined;

  if (out.intent === "smalltalk" || out.intent === "checkout") {
    return {
      intent: out.intent,
      mission: null,
      draft: null,
      missingFields: [],
      reply,
    };
  }

  // The model extracts facts; application code decides what is required.
  // Country/currency use the configured market defaults and must never turn
  // into schema-shaped onboarding questions.
  const draft = out.mission
    ? normalizeDraft(out.mission, currentDraft)
    : currentDraft;
  const missingFields = draft
    ? [...(draft.goal ? [] : ["goal"]), ...(draft.budget ? [] : ["budget"])]
    : out.missingFields.filter(
        (field) => field === "goal" || field === "budget",
      );
  if (!draft || missingFields.length > 0) {
    return {
      intent: out.intent,
      mission: null,
      draft,
      missingFields,
      reply,
    };
  }

  const m = draft;
  const budget = m.budget!;
  const isRevise = out.intent === "revise" && current !== null;

  const slots: MissionSlot[] = m.slots.map((slot) => {
    const existing = current?.slots.find(
      (s) => s.label.toLowerCase() === slot.label.toLowerCase(),
    );
    if (existing?.locked) return existing; // never touch a locked slot
    if (existing && sameSlotSpec(existing, slot)) return existing;
    return {
      id: existing?.id ?? crypto.randomUUID(),
      label: slot.label,
      query: slot.query,
      required: slot.required,
      hardConstraints: slot.hardConstraints,
      softPreferences: slot.softPreferences,
      candidates: [],
      locked: false,
    };
  });

  const mission = shoppingMissionSchema.parse({
    id: isRevise ? current!.id : crypto.randomUUID(),
    goal: m.goal,
    countryCode: m.countryCode,
    budget: {
      amount: Math.round(budget.amount * 100), // dollars -> integer cents
      currency: budget.currency.toUpperCase(),
    },
    globalHardConstraints: m.globalHardConstraints,
    globalPreferences: m.globalPreferences,
    slots,
    status: "draft",
  });

  return { intent: out.intent, mission, draft: null, missingFields: [], reply };
}
