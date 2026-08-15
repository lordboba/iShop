import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { app as appCard, type Message, type Space } from "spectrum-ts";
import type {
  BundleResult,
  CheckoutPlan,
  ProductCandidate,
  ShoppingMission,
} from "../domain/mission";
import { selectBundle } from "../optimizer/select-bundle";
import type { createMerchantCarts } from "../shopify/cart";
import type { searchCatalog } from "../shopify/catalog";
import { checkoutBlockers, type MissionStore } from "../state/mission-store";
import { buildCheckoutPlan, CheckoutBlockedError } from "./checkout";
import {
  parseMission,
  type MissionDraft,
  type MissionModelClient,
} from "./mission-parser";

export type SpectrumApp = { messages: AsyncIterable<[Space, Message]> };

export type AgentLoopDeps = {
  store: MissionStore;
  client: MissionModelClient;
  searchCatalog: typeof searchCatalog;
  createMerchantCarts: typeof createMerchantCarts;
  publicBaseUrl: string; // for app() card URLs
};

const SEARCH_CONCURRENCY = 3;

// Persist every inbound conversation so we can proactively message it later
// (Spectrum has no space-listing API; capture-on-inbound is the only path).
const STATE_DIR = new URL("../../.state/", import.meta.url).pathname;
const SPACES_FILE = `${STATE_DIR}spaces.json`;

function recordSpace(spaceId: string, senderId: string | undefined): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const known: Record<string, { senderId?: string; lastSeen: string }> =
    existsSync(SPACES_FILE)
      ? JSON.parse(readFileSync(SPACES_FILE, "utf8"))
      : {};
  known[spaceId] = { senderId, lastSeen: new Date().toISOString() };
  writeFileSync(SPACES_FILE, JSON.stringify(known, null, 2));
}

// Per-space conversational state that lives outside the mission reducer:
// a pending inspiration photo and the card message we edit in place.
export type SpaceSession = {
  pendingImageUrl?: string;
  cardMessage?: Message;
  draft?: MissionDraft;
};

export async function runAgentLoop(
  app: SpectrumApp,
  deps: AgentLoopDeps,
): Promise<void> {
  const sessions = new Map<string, SpaceSession>();

  for await (const [space, message] of app.messages) {
    if (message.direction === "outbound") continue;

    let session = sessions.get(space.id);
    if (!session) {
      session = {};
      sessions.set(space.id, session);
    }

    try {
      recordSpace(space.id, message.sender?.id);
      await handleInbound(space, message, deps, session);
    } catch (error) {
      console.error(`[loop] space=${space.id} message handling failed:`, error);
      await space
        .send("Something went wrong on my end — please send that again.")
        .catch(() => undefined);
    }
  }
}

export async function handleInbound(
  space: Space,
  message: Message,
  deps: AgentLoopDeps,
  session: SpaceSession,
): Promise<void> {
  const content = message.content;

  if (content.type === "attachment") {
    if (!content.mimeType.startsWith("image/")) return;
    // iMessage attachments arrive as bytes, not URLs; a data URL feeds
    // straight into the vision model as inspiration input.
    const bytes = await content.read();
    session.pendingImageUrl = `data:${content.mimeType};base64,${bytes.toString("base64")}`;
    await space.send(
      "Got the photo — tell me the goal, budget, and any must-haves.",
    );
    return;
  }

  if (content.type !== "text") return;
  const text = content.text.trim();
  if (!text) return;

  await space.responding(async () => {
    const imageUrl = session.pendingImageUrl;
    const current = deps.store.getBySpace(space.id);
    const parsed = await parseMission(
      { text, imageUrl },
      current,
      deps.client,
      session.draft ?? null,
    );

    switch (parsed.intent) {
      case "smalltalk":
        await space.send(
          parsed.reply ??
            "Hi! Text me a shopping goal with a budget and I'll assemble the kit.",
        );
        return;

      case "checkout":
        await handleCheckout(space, deps, parsed.reply);
        return;

      case "create":
      case "revise": {
        if (!parsed.mission) {
          session.draft = parsed.draft ?? session.draft;
          await space.send(askForMissing(parsed.missingFields, session.draft));
          return;
        }
        session.draft = undefined;
        session.pendingImageUrl = undefined; // consumed by this mission
        await runMissionSearch(space, deps, session, parsed.mission, imageUrl);
        return;
      }
    }
  });
}

// The parse model call takes seconds, and the card server dispatches
// lock/unlock/select actions on the shared store while it runs — but the
// parser builds slots from a pre-parse snapshot. Before the wholesale put,
// re-apply live slot state (matched by id) so a concurrent card action is
// never silently discarded: a live lock always wins, and an unchanged spec
// keeps the live candidates/selection instead of the stale ones. A changed
// spec keeps the parsed slot — a real revision clears candidates on purpose.
export function mergeLiveSlotState(
  parsed: ShoppingMission,
  live: ShoppingMission,
): ShoppingMission {
  return {
    ...parsed,
    slots: parsed.slots.map((slot) => {
      const liveSlot = live.slots.find((s) => s.id === slot.id);
      if (!liveSlot) return slot;
      if (liveSlot.locked) return liveSlot; // never touch a locked slot
      const sameSpec =
        slot.query === liveSlot.query &&
        JSON.stringify(slot.hardConstraints) ===
          JSON.stringify(liveSlot.hardConstraints) &&
        JSON.stringify(slot.softPreferences) ===
          JSON.stringify(liveSlot.softPreferences);
      if (!sameSpec) return slot;
      return {
        ...slot,
        locked: liveSlot.locked,
        selectedVariantId: liveSlot.selectedVariantId,
        candidates: liveSlot.candidates,
      };
    }),
  };
}

async function runMissionSearch(
  space: Space,
  deps: AgentLoopDeps,
  session: SpaceSession,
  parsedMission: ShoppingMission,
  imageUrl: string | undefined,
): Promise<void> {
  const previous = deps.store.getBySpace(space.id);
  const isNewMission = previous?.id !== parsedMission.id;
  const mission =
    isNewMission || !previous
      ? parsedMission
      : mergeLiveSlotState(parsedMission, previous);
  deps.store.put(space.id, mission);

  // The parser preserves locked slots and unchanged slot objects verbatim
  // (candidates intact), so "unlocked with no candidates" is exactly the set
  // of new/changed slots. Locked slots are never searched or re-selected.
  const slotsToSearch = mission.slots.filter(
    (slot) => !slot.locked && slot.candidates.length === 0,
  );
  const cardUrl = `${deps.publicBaseUrl}/card/mission/${mission.id}`;

  await space.send(ackLine(mission, isNewMission, slotsToSearch.length));

  if (slotsToSearch.length > 0) {
    deps.store.dispatch(space.id, {
      type: "searchStarted",
      slotIds: slotsToSearch.map((slot) => slot.id),
    });
  }

  // The card goes out immediately in searching state and is edited in place
  // as slots resolve, so the thread never feels dead during a long search.
  if (isNewMission || !session.cardMessage) {
    session.cardMessage = await space.send(appCard(cardUrl, { live: true }));
  } else {
    await refreshCard(session, cardUrl);
  }

  const failedSlots: string[] = [];
  await mapWithConcurrency(slotsToSearch, SEARCH_CONCURRENCY, async (slot) => {
    try {
      const found = await deps.searchCatalog({
        query: slot.query,
        countryCode: mission.countryCode,
        imageUrl,
      });
      const hard = [...mission.globalHardConstraints, ...slot.hardConstraints];
      deps.store.dispatch(space.id, {
        type: "candidatesLoaded",
        slotId: slot.id,
        candidates: found.map((candidate) =>
          annotateConstraints(candidate, hard),
        ),
      });
    } catch (error) {
      console.error(`[loop] search failed for slot "${slot.label}":`, error);
      failedSlots.push(slot.label);
    }
    await refreshCard(session, cardUrl);
  });

  const latest = deps.store.getBySpace(space.id);
  if (!latest || latest.id !== mission.id) return; // replaced mid-search

  const bundle = selectBundle(latest);
  if (bundle.status === "ready") {
    // The reducer refuses selection changes on locked slots, so re-optimizing
    // after a revision can only move unlocked slots.
    for (const [slotId, variantId] of Object.entries(bundle.selections)) {
      deps.store.dispatch(space.id, {
        type: "candidateSelected",
        slotId,
        variantId,
      });
    }
  }
  await refreshCard(session, cardUrl);

  if (failedSlots.length > 0) {
    await space.send(
      `Search failed for ${failedSlots.join(", ")} — keeping the partial results I found; ask me to retry anytime.`,
    );
  }
  await space.send(
    bundleSummary(deps.store.getBySpace(space.id) ?? latest, bundle),
  );
}

async function handleCheckout(
  space: Space,
  deps: AgentLoopDeps,
  reply?: string,
): Promise<void> {
  const mission = deps.store.getBySpace(space.id);
  if (!mission) {
    await space.send(
      reply ??
        "There's no active mission yet — text me a goal and budget first.",
    );
    return;
  }

  // Approval is enforced here in code (explicit checkout intent from the
  // buyer plus zero blockers) — never taken from model output.
  const blockers = checkoutBlockers(mission);
  if (blockers.length > 0) {
    await space.send(`Not ready for checkout: ${blockers.join("; ")}.`);
    return;
  }

  let plan: CheckoutPlan;
  try {
    plan = await buildCheckoutPlan(mission, {
      createMerchantCarts: deps.createMerchantCarts,
    });
  } catch (error) {
    if (error instanceof CheckoutBlockedError) {
      await space.send(`Not ready for checkout: ${error.blockers.join("; ")}.`);
      return;
    }
    console.error(`[loop] checkout failed for mission ${mission.id}:`, error);
    await space.send(
      'I couldn\'t refresh the merchant carts just now — nothing was purchased. Try "checkout" again in a moment.',
    );
    return;
  }

  deps.store.putCheckoutPlan(mission.id, plan);
  deps.store.dispatch(space.id, { type: "checkoutStarted" });
  await space.send(
    appCard(`${deps.publicBaseUrl}/card/checkout/${mission.id}`, {
      live: true,
    }),
  );
  await space.send(checkoutSummary(plan, mission.budget.currency));
}

// ---------- helpers ----------

function askForMissing(missingFields: string[], draft?: MissionDraft): string {
  if (missingFields.includes("goal")) {
    if (draft?.budget) {
      const amount = Number.isInteger(draft.budget.amount)
        ? String(draft.budget.amount)
        : draft.budget.amount.toFixed(2);
      const budget =
        draft.budget.currency === "USD"
          ? `$${amount}`
          : `${amount} ${draft.budget.currency}`;
      return `Got it — ${budget}. What would you like to shop for?`;
    }
    return "What would you like to shop for?";
  }
  if (missingFields.includes("budget")) {
    return draft?.goal
      ? `${draft.goal} — got it. What's your maximum budget?`
      : "What's your maximum budget?";
  }
  return "Tell me a bit more about what you need.";
}

function ackLine(
  mission: ShoppingMission,
  isNewMission: boolean,
  searchCount: number,
): string {
  const budget = money(mission.budget.amount, mission.budget.currency);
  if (isNewMission) {
    return `On it — building "${mission.goal}" under ${budget} (${mission.slots.length} items).`;
  }
  return searchCount > 0
    ? `Updating ${searchCount === 1 ? "1 item" : `${searchCount} items`} — locked picks stay put.`
    : "Updated the plan — locked picks stay put.";
}

function bundleSummary(mission: ShoppingMission, bundle: BundleResult): string {
  if (bundle.status === "infeasible") {
    return `I couldn't complete a valid bundle yet: ${bundle.blockers.join("; ")}.`;
  }
  const ready = mission.slots.filter((slot) => slot.selectedVariantId).length;
  const total = money(bundle.total, mission.budget.currency);
  const budget = money(mission.budget.amount, mission.budget.currency);
  return `${ready} of ${mission.slots.length} items ready — ${total} of your ${budget} budget. Say "lock the <item>", ask for changes, or say "checkout".`;
}

function checkoutSummary(plan: CheckoutPlan, currency: string): string {
  const merchants =
    plan.merchants.length === 1
      ? "1 merchant"
      : `${plan.merchants.length} merchants`;
  const live = money(plan.liveTotal, currency);
  // Handoff merchants have no cart API, so their prices were never re-checked
  // — never present a total that includes them as live-verified.
  const hasHandoff = plan.merchants.some((m) => m.mode === "handoff");
  const totalLabel = hasHandoff
    ? `total ${live} (some prices couldn't be re-checked — confirm on the card)`
    : `live total ${live}`;
  if (plan.priceChanges.length === 0) {
    return hasHandoff
      ? `${merchants}, ${totalLabel}. Tap a checkout link on the card when ready.`
      : `${merchants}, ${totalLabel} — no price changes since you picked. Tap a checkout link on the card when ready.`;
  }
  const changed =
    plan.priceChanges.length === 1
      ? "1 price"
      : `${plan.priceChanges.length} prices`;
  return `${merchants}, ${totalLabel} — was ${money(plan.previousTotal, currency)}; ${changed} changed since selection. Check the card before paying.`;
}

function money(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  return currency === "USD" ? `$${amount}` : `${amount} ${currency}`;
}

async function refreshCard(
  session: SpaceSession,
  cardUrl: string,
): Promise<void> {
  if (!session.cardMessage) return;
  try {
    await session.cardMessage.edit(appCard(cardUrl, { live: true }));
  } catch (error) {
    // Live cards re-render on open regardless; a failed edit only affects the
    // thread preview, so log and move on.
    console.warn(
      "[loop] card edit failed (card still updates on open):",
      error,
    );
  }
}

// Deterministic keyword annotation: a hard constraint whose text appears in
// the title/options counts as matched; anything unverifiable stays visible as
// "uncertain" (scored down by the optimizer and flagged on the card) rather
// than silently pruning every candidate or claiming a match we can't back.
function annotateConstraints(
  candidate: ProductCandidate,
  hard: string[],
): ProductCandidate {
  if (hard.length === 0) return candidate;
  const haystack = [
    candidate.title,
    ...Object.values(candidate.selectedOptions),
  ]
    .join(" ")
    .toLowerCase();
  const matched = [...candidate.matchedConstraints];
  const uncertain = [...candidate.uncertainConstraints];
  for (const constraint of hard) {
    if (matched.includes(constraint) || uncertain.includes(constraint))
      continue;
    (haystack.includes(constraint.toLowerCase()) ? matched : uncertain).push(
      constraint,
    );
  }
  return {
    ...candidate,
    matchedConstraints: matched,
    uncertainConstraints: uncertain,
  };
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await worker(item);
      }
    },
  );
  await Promise.all(runners);
}
