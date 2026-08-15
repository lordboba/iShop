import type { CheckoutPlan, MerchantCart, ShoppingMission } from "../../domain/mission";
import { cardStyles, escapeHtml, formatMoney } from "./mission";

const checkoutStyles = `
  .merchant-head { display: flex; justify-content: space-between; align-items: baseline;
                   gap: 8px; margin-bottom: 6px; }
  .item { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0;
          border-top: 1px solid var(--line); font-size: 14px; }
  .qty { color: var(--muted); }
  .was { color: var(--muted); text-decoration: line-through; font-size: 12px; margin-right: 4px; }
  .changed { background: var(--accent-soft); color: var(--accent); border-radius: 6px;
             padding: 1px 6px; font-weight: 600; }
  .subtotal { display: flex; justify-content: space-between; padding-top: 8px;
              border-top: 1px solid var(--line); font-weight: 600; }
  a.checkout-link { display: block; text-align: center; margin-top: 10px; padding: 9px 12px;
                    border-radius: 10px; background: var(--accent); color: #fff;
                    font-weight: 600; text-decoration: none; }
  a.checkout-link.secondary { background: transparent; color: var(--accent);
                              border: 1px solid var(--accent); font-weight: 500; }
  .notice { background: var(--accent-soft); border: 1px solid var(--accent); color: var(--accent);
            border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; font-size: 13px; }
  .handoff-note { color: var(--muted); font-size: 12px; margin-top: 8px; }
`;

function itemRow(
  item: MerchantCart["items"][number],
  change: { before: number; after: number } | undefined,
  currency: string,
): string {
  const price = change
    ? `<span class="was">${formatMoney(change.before, currency)}</span><span class="changed">${formatMoney(change.after, currency)}</span>`
    : formatMoney(item.livePrice * item.quantity, currency);
  return `<div class="item">
    <span>${escapeHtml(item.title)}${item.quantity > 1 ? ` <span class="qty">×${item.quantity}</span>` : ""}</span>
    <span class="price">${price}</span>
  </div>`;
}

function checkoutLinks(merchant: MerchantCart): string {
  if (merchant.mode === "cart") {
    return `<a class="checkout-link" href="${escapeHtml(merchant.continueUrl)}">Open secure checkout</a>`;
  }
  // Handoff: no cart API, so prices were never revalidated. A combined cart
  // permalink adds every item in one tap; per-item links remain as fallback.
  const combined =
    merchant.items.length > 1 && merchant.continueUrl.includes("/cart/")
      ? `<a class="checkout-link" href="${escapeHtml(merchant.continueUrl)}">Add all ${merchant.items.length} items to cart</a>`
      : "";
  const links = merchant.items
    .map((item) =>
      item.buyUrl
        ? `<a class="checkout-link${combined ? " secondary" : ""}" href="${escapeHtml(item.buyUrl)}">Buy ${escapeHtml(item.title)}</a>`
        : `<a class="checkout-link${combined ? " secondary" : ""}" href="${escapeHtml(merchant.continueUrl)}">Find ${escapeHtml(item.title)} on ${escapeHtml(merchant.domain)}</a>`,
    )
    .join("");
  const note = combined
    ? "Prices are from when you picked — confirm on the merchant site."
    : "Prices are from when you picked — confirm on the merchant site. Each link buys one item.";
  return `<div class="handoff-note">${note}</div>${combined}${links}`;
}

function merchantSection(merchant: MerchantCart, plan: CheckoutPlan, currency: string): string {
  const changeFor = (variantId: string) => plan.priceChanges.find((p) => p.variantId === variantId);
  return `<section class="card">
    <div class="merchant-head">
      <strong>${escapeHtml(merchant.name)}</strong>
      <span class="seller">${escapeHtml(merchant.domain)}</span>
    </div>
    ${merchant.items.map((item) => itemRow(item, changeFor(item.variantId), currency)).join("")}
    <div class="subtotal"><span>Subtotal</span><span>${formatMoney(merchant.subtotal, currency)}</span></div>
    ${checkoutLinks(merchant)}
  </section>`;
}

export function renderCheckoutCard(mission: ShoppingMission, plan: CheckoutPlan): string {
  const currency = mission.budget.currency;
  const changed = plan.priceChanges.length > 0;
  // Handoff merchants were never revalidated — the total is not "live".
  const hasHandoff = plan.merchants.some((merchant) => merchant.mode === "handoff");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>iShop · Checkout · ${escapeHtml(mission.goal)}</title>
<style>${cardStyles}${checkoutStyles}</style>
</head>
<body>
<main>
  <div class="brand">iShop · The shopping agent in your iPhone</div>
  <h1>Checkout</h1>
  <div class="sub">${escapeHtml(mission.goal)} · ${plan.merchants.length} merchant${plan.merchants.length === 1 ? "" : "s"}</div>
  <div class="card">
    <div class="row"><span class="grow">${hasHandoff ? "Total" : "Live total"}</span>
      <span class="price">${formatMoney(plan.liveTotal, currency)}</span>
    </div>
    ${changed ? `<div class="sub">was ${formatMoney(plan.previousTotal, currency)}</div>` : ""}
    ${hasHandoff ? `<div class="sub">Includes items whose prices couldn't be re-checked — confirm on the merchant site.</div>` : ""}
  </div>
  ${changed ? `<div class="notice"><strong>Prices changed</strong> since your last look — updated amounts are highlighted below.</div>` : ""}
  ${plan.merchants.map((m) => merchantSection(m, plan, currency)).join("")}
</main>
</body>
</html>`;
}
