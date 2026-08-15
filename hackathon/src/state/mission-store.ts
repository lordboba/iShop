import type {
  CheckoutPlan,
  MissionSlot,
  ProductCandidate,
  ShoppingMission,
} from "../domain/mission";

export type MissionAction =
  | { type: "missionParsed"; mission: ShoppingMission }
  | { type: "searchStarted"; slotIds: string[] }
  | { type: "candidatesLoaded"; slotId: string; candidates: ProductCandidate[] }
  | { type: "slotLocked"; slotId: string }
  | { type: "slotUnlocked"; slotId: string }
  | { type: "candidateSelected"; slotId: string; variantId: string }
  | {
      type: "slotRevised";
      slotId: string;
      query: string;
      hardConstraints: string[];
      softPreferences: string[];
    }
  | { type: "checkoutStarted" };

function updateSlot(
  mission: ShoppingMission,
  slotId: string,
  update: (slot: MissionSlot) => MissionSlot,
): ShoppingMission {
  return {
    ...mission,
    slots: mission.slots.map((slot) => (slot.id === slotId ? update(slot) : slot)),
  };
}

function selectedCandidate(slot: MissionSlot): ProductCandidate | null {
  if (!slot.selectedVariantId) return null;
  return slot.candidates.find((c) => c.variantId === slot.selectedVariantId) ?? null;
}

export function reduceMission(mission: ShoppingMission, action: MissionAction): ShoppingMission {
  switch (action.type) {
    case "missionParsed":
      return action.mission;

    case "searchStarted":
      return { ...mission, status: "searching" };

    case "candidatesLoaded": {
      const next = updateSlot(mission, action.slotId, (slot) => {
        const previous = selectedCandidate(slot);
        let candidates = action.candidates;
        let selectedVariantId = slot.selectedVariantId;
        const stillPresent =
          selectedVariantId !== undefined &&
          candidates.some((c) => c.variantId === selectedVariantId);
        if (slot.locked && previous && !stillPresent) {
          // locked selections survive a refresh even if the search dropped them
          candidates = [previous, ...candidates];
        } else if (!slot.locked && !stillPresent) {
          selectedVariantId = undefined;
        }
        return { ...slot, candidates, selectedVariantId };
      });
      const allLoaded = next.slots.every((slot) => slot.candidates.length > 0);
      return next.status === "searching" && allLoaded ? { ...next, status: "ready" } : next;
    }

    case "slotLocked":
      // Locking an empty slot would dead-end it: the optimizer treats it as
      // free while the reducer refuses selections. Only a selection can lock.
      return updateSlot(mission, action.slotId, (slot) =>
        selectedCandidate(slot) ? { ...slot, locked: true } : slot,
      );

    case "slotUnlocked":
      return updateSlot(mission, action.slotId, (slot) => ({ ...slot, locked: false }));

    case "candidateSelected":
      return updateSlot(mission, action.slotId, (slot) => {
        if (slot.locked) return slot;
        if (!slot.candidates.some((c) => c.variantId === action.variantId)) return slot;
        return { ...slot, selectedVariantId: action.variantId };
      });

    case "slotRevised":
      return updateSlot(mission, action.slotId, (slot) => {
        const revised = {
          ...slot,
          query: action.query,
          hardConstraints: action.hardConstraints,
          softPreferences: action.softPreferences,
        };
        if (slot.locked) return revised;
        return { ...revised, candidates: [], selectedVariantId: undefined };
      });

    case "checkoutStarted":
      return { ...mission, status: "checkout" };
  }
}

export function selectedProducts(mission: ShoppingMission): ProductCandidate[] {
  return mission.slots
    .map(selectedCandidate)
    .filter((c): c is ProductCandidate => c !== null);
}

export function selectedTotal(mission: ShoppingMission): number {
  return selectedProducts(mission).reduce((sum, c) => sum + c.price, 0);
}

export function checkoutBlockers(mission: ShoppingMission): string[] {
  const blockers: string[] = [];
  for (const slot of mission.slots) {
    if (slot.required && !selectedCandidate(slot)) {
      blockers.push(`Required slot "${slot.label}" has no selected product`);
    }
  }
  const total = selectedTotal(mission);
  if (total > mission.budget.amount) {
    // Blockers are texted verbatim; amounts are integer cents -> major units.
    const { amount, currency } = mission.budget;
    blockers.push(
      `Selected total ${(total / 100).toFixed(2)} ${currency} exceeds budget ${(amount / 100).toFixed(2)} ${currency}`,
    );
  }
  return blockers;
}

export class MissionStore {
  private bySpace = new Map<string, ShoppingMission>();
  private spaceByMission = new Map<string, string>();
  private plans = new Map<string, CheckoutPlan>();

  getBySpace(spaceId: string): ShoppingMission | null {
    return this.bySpace.get(spaceId) ?? null;
  }

  getByMissionId(missionId: string): ShoppingMission | null {
    const spaceId = this.spaceByMission.get(missionId);
    if (spaceId === undefined) return null;
    return this.getBySpace(spaceId);
  }

  spaceIdForMission(missionId: string): string | null {
    return this.spaceByMission.get(missionId) ?? null;
  }

  put(spaceId: string, mission: ShoppingMission): void {
    const previous = this.bySpace.get(spaceId);
    if (previous && previous.id !== mission.id) {
      // a new brief replaces the old mission for this space
      this.spaceByMission.delete(previous.id);
      this.plans.delete(previous.id);
    }
    this.bySpace.set(spaceId, mission);
    this.spaceByMission.set(mission.id, spaceId);
  }

  dispatch(spaceId: string, action: MissionAction): ShoppingMission {
    const mission = this.bySpace.get(spaceId);
    if (!mission) throw new Error(`No mission for space ${spaceId}`);
    const next = reduceMission(mission, action);
    this.put(spaceId, next);
    return next;
  }

  putCheckoutPlan(missionId: string, plan: CheckoutPlan): void {
    this.plans.set(missionId, plan);
  }

  getCheckoutPlan(missionId: string): CheckoutPlan | null {
    return this.plans.get(missionId) ?? null;
  }
}
