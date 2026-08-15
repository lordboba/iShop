import type { CheckoutPlan, ShoppingMission } from "../domain/mission";
import { computePriceChanges, type createMerchantCarts } from "../shopify/cart";
import { checkoutBlockers, selectedProducts, selectedTotal } from "../state/mission-store";

// Checkout is a code-enforced boundary. A plan is built only from reducer
// state (checkoutBlockers / selectedProducts) plus live cart responses —
// approval is never derived from model output. A mission with blockers can
// never produce a plan, regardless of what any model claimed.
export class CheckoutBlockedError extends Error {
  constructor(public readonly blockers: string[]) {
    super(`checkout blocked: ${blockers.join("; ")}`);
    this.name = "CheckoutBlockedError";
  }
}

export async function buildCheckoutPlan(
  mission: ShoppingMission,
  deps: { createMerchantCarts: typeof createMerchantCarts },
): Promise<CheckoutPlan> {
  const blockers = checkoutBlockers(mission);
  if (blockers.length > 0) throw new CheckoutBlockedError(blockers);

  // Rebuild live data from merchant carts: variant ids + country only —
  // never model-generated prices.
  const products = selectedProducts(mission);
  const merchants = await deps.createMerchantCarts(products, mission.countryCode);

  // Every approved variant must reappear in a refreshed cart. A silently
  // dropped item must never reach the buyer as a "complete" checkout.
  const liveVariantIds = new Set(
    merchants.flatMap((cart) => cart.items.map((item) => item.variantId)),
  );
  const missing = products.filter((product) => !liveVariantIds.has(product.variantId));
  if (missing.length > 0) {
    throw new CheckoutBlockedError(
      missing.map(
        (product) => `"${product.title}" (${product.variantId}) is missing from the refreshed merchant cart`,
      ),
    );
  }

  return {
    merchants,
    previousTotal: selectedTotal(mission),
    liveTotal: merchants.reduce((sum, cart) => sum + cart.subtotal, 0),
    priceChanges: computePriceChanges(products, merchants),
  };
}
