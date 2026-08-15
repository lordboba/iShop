import { z } from "zod";

// All prices are integer minor currency units (cents). The model never does
// authoritative arithmetic — totals come from reducer selectors.

// Merchant-supplied URLs end up in href/src attributes inside card webviews.
// zod's .url() accepts javascript:/data: schemes, so require https explicitly.
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const httpsUrlSchema = z.string().url().refine(isHttpsUrl, { message: "must be an https URL" });

export const productCandidateSchema = z.object({
  productId: z.string(),
  variantId: z.string(),
  title: z.string(),
  imageUrl: httpsUrlSchema.optional(),
  sellerName: z.string(),
  sellerDomain: z.string(),
  price: z.number().int().nonnegative(),
  currency: z.string().length(3),
  selectedOptions: z.record(z.string(), z.string()).default({}),
  buyUrl: httpsUrlSchema.optional(),
  matchedConstraints: z.array(z.string()).default([]),
  uncertainConstraints: z.array(z.string()).default([]),
});

export const missionSlotSchema = z.object({
  id: z.string(),
  label: z.string(),
  query: z.string(),
  required: z.boolean(),
  hardConstraints: z.array(z.string()),
  softPreferences: z.array(z.string()),
  candidates: z.array(productCandidateSchema).default([]),
  selectedVariantId: z.string().optional(),
  locked: z.boolean().default(false),
});

export const shoppingMissionSchema = z.object({
  id: z.string(),
  goal: z.string(),
  countryCode: z.string().length(2).default("US"),
  budget: z.object({
    amount: z.number().int().positive(),
    currency: z.string().length(3),
  }),
  globalHardConstraints: z.array(z.string()).default([]),
  globalPreferences: z.array(z.string()).default([]),
  slots: z.array(missionSlotSchema).min(1).max(5),
  status: z.enum(["draft", "searching", "ready", "checkout"]),
});

export type ShoppingMission = z.infer<typeof shoppingMissionSchema>;
export type MissionSlot = z.infer<typeof missionSlotSchema>;
export type ProductCandidate = z.infer<typeof productCandidateSchema>;

export type BundleResult =
  | {
      status: "ready";
      selections: Record<string, string>; // slotId -> variantId
      total: number;
      merchantCount: number;
    }
  | { status: "infeasible"; blockers: string[]; closestTotal?: number };

export type MerchantCart = {
  name: string;
  domain: string;
  items: Array<{
    variantId: string;
    title: string;
    quantity: number;
    livePrice: number;
    buyUrl?: string; // handoff mode: per-item buy link (one link buys one item)
  }>;
  subtotal: number;
  continueUrl: string;
  mode: "cart" | "handoff";
};

export type CheckoutPlan = {
  merchants: MerchantCart[];
  previousTotal: number;
  liveTotal: number;
  priceChanges: Array<{ variantId: string; before: number; after: number }>;
};
