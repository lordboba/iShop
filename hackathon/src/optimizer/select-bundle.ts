import type {
  BundleResult,
  MissionSlot,
  ProductCandidate,
  ShoppingMission,
} from "../domain/mission";

// Candidate order is its relevance rank; skipping an optional slot must rank
// worse than any real candidate (max 6 per slot).
const SKIP_RELEVANCE_COST = 6;

type Option = { candidate: ProductCandidate; relevance: number } | null;

// [over budget, relevance sum, uncertain count, merchant count, total]
type Cost = [number, number, number, number, number];

function violatesHard(candidate: ProductCandidate, hard: string[]): boolean {
  // A hard constraint in neither matched nor uncertain lists is a violation.
  return hard.some(
    (constraint) =>
      !candidate.matchedConstraints.includes(constraint) &&
      !candidate.uncertainConstraints.includes(constraint),
  );
}

// Lexicographic cost, lower is better:
// over budget -> relevance sum -> uncertain count -> merchant count -> total.
// Required-filled, no-hard-violation, and locked-preserved are enforced by
// construction (blockers / pruning / forced picks) before enumeration.
function scoreBundle(picks: Option[], budget: number): Cost {
  let total = 0;
  let relevance = 0;
  let uncertain = 0;
  const merchants = new Set<string>();
  for (const pick of picks) {
    if (!pick) {
      relevance += SKIP_RELEVANCE_COST;
      continue;
    }
    total += pick.candidate.price;
    relevance += pick.relevance;
    uncertain += pick.candidate.uncertainConstraints.length;
    merchants.add(pick.candidate.sellerDomain);
  }
  return [total > budget ? 1 : 0, relevance, uncertain, merchants.size, total];
}

function compareCost(a: Cost, b: Cost): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function selectBundle(mission: ShoppingMission): BundleResult {
  const blockers: string[] = [];
  const slotOptions: Array<{ slot: MissionSlot; options: Option[] }> = [];

  for (const slot of mission.slots) {
    const hard = [...mission.globalHardConstraints, ...slot.hardConstraints];

    if (slot.locked && slot.selectedVariantId) {
      const kept = slot.candidates.find(
        (c) => c.variantId === slot.selectedVariantId,
      );
      if (!kept) {
        blockers.push(
          `"${slot.label}" is locked to a variant that is no longer available`,
        );
        continue;
      }
      // A locked selection is kept verbatim, even when its constraint match
      // is uncertain — the user chose it.
      slotOptions.push({
        slot,
        options: [{ candidate: kept, relevance: slot.candidates.indexOf(kept) }],
      });
      continue;
    }

    const viable = slot.candidates
      .map((candidate, relevance) => ({ candidate, relevance }))
      .filter(({ candidate }) => !violatesHard(candidate, hard));

    if (viable.length === 0) {
      if (slot.required) {
        blockers.push(`no viable candidate for "${slot.label}"`);
      } else {
        slotOptions.push({ slot, options: [null] });
      }
      continue;
    }
    slotOptions.push({
      slot,
      options: slot.required ? viable : [...viable, null],
    });
  }

  if (blockers.length > 0) return { status: "infeasible", blockers };

  let best: { picks: Option[]; cost: Cost } | null = null;
  let minTotal = Infinity;

  const enumerate = (index: number, picks: Option[]) => {
    if (index === slotOptions.length) {
      const cost = scoreBundle(picks, mission.budget.amount);
      minTotal = Math.min(minTotal, cost[4]);
      if (!best || compareCost(cost, best.cost) < 0) {
        best = { picks: [...picks], cost };
      }
      return;
    }
    for (const option of slotOptions[index]?.options ?? []) {
      picks.push(option);
      enumerate(index + 1, picks);
      picks.pop();
    }
  };
  enumerate(0, []);

  if (!best) return { status: "infeasible", blockers: ["no slots to fill"] };
  const chosen: { picks: Option[]; cost: Cost } = best;

  const [overBudget, , , merchantCount, total] = chosen.cost;
  if (overBudget) {
    // Blockers are texted verbatim; amounts are integer cents -> major units.
    const asMajor = (cents: number) => `${(cents / 100).toFixed(2)} ${mission.budget.currency}`;
    return {
      status: "infeasible",
      blockers: [
        `cheapest valid bundle (${asMajor(minTotal)}) exceeds budget (${asMajor(mission.budget.amount)})`,
      ],
      closestTotal: minTotal,
    };
  }

  const selections: Record<string, string> = {};
  chosen.picks.forEach((pick, i) => {
    const entry = slotOptions[i];
    if (pick && entry) selections[entry.slot.id] = pick.candidate.variantId;
  });
  return { status: "ready", selections, total, merchantCount };
}
