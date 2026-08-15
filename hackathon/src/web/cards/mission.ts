import type {
  MissionSlot,
  ProductCandidate,
  ShoppingMission,
} from "../../domain/mission";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function selectedCandidate(slot: MissionSlot): ProductCandidate | undefined {
  if (!slot.selectedVariantId) return undefined;
  return slot.candidates.find((c) => c.variantId === slot.selectedVariantId);
}

export function missionSelectedTotal(mission: ShoppingMission): number {
  return mission.slots.reduce((sum, slot) => sum + (selectedCandidate(slot)?.price ?? 0), 0);
}

export function missionBlockers(mission: ShoppingMission): string[] {
  const out: string[] = [];
  for (const slot of mission.slots) {
    if (slot.required && !selectedCandidate(slot)) out.push(`Missing required item: ${slot.label}`);
  }
  const total = missionSelectedTotal(mission);
  if (total > mission.budget.amount) {
    out.push(`Over budget by ${formatMoney(total - mission.budget.amount, mission.budget.currency)}`);
  }
  return out;
}

// Shared card chrome: warm neutral canvas, near-black type, one electric accent.
export const cardStyles = `
  :root { --canvas: #faf6f0; --ink: #17130e; --muted: #6f675c; --line: #e7ddcf;
          --accent: #4f46e5; --accent-soft: #eceafc; --warn: #b3261e; --warn-soft: #fbeae9; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--canvas); color: var(--ink); padding: 14px;
         font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 480px; margin: 0 auto; }
  h1 { font-size: 19px; line-height: 1.25; margin-bottom: 4px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 10px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
  .chip { font-size: 12px; padding: 2px 8px; border-radius: 999px;
          border: 1px solid var(--line); background: #fff; }
  .chip.matched { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .chip.uncertain { border-style: dashed; color: var(--muted); }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 12px;
          padding: 12px; margin-bottom: 10px; }
  .row { display: flex; gap: 10px; align-items: flex-start; }
  .thumb { width: 64px; height: 64px; aspect-ratio: 1 / 1; border-radius: 8px;
           object-fit: cover; background: var(--line); flex-shrink: 0; display: block; }
  .grow { flex: 1; min-width: 0; }
  .price { font-weight: 600; white-space: nowrap; }
  .seller, .variant { color: var(--muted); font-size: 12px; }
  .bar { height: 8px; border-radius: 999px; background: var(--line); overflow: hidden; margin: 6px 0 4px; }
  .bar > i { display: block; height: 100%; background: var(--accent); }
  .bar.over > i { background: var(--warn); }
  .blockers { background: var(--warn-soft); border: 1px solid var(--warn); color: var(--warn);
              border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; font-size: 13px; }
  .blockers li { margin-left: 16px; }
  .actions { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
  button, .btn { font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 8px;
                 border: 1px solid var(--line); background: #fff; color: var(--ink); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .locked-tag { color: var(--accent); font-size: 12px; font-weight: 600; }
  details summary { font-size: 13px; cursor: pointer; color: var(--muted); }
  .alt { display: flex; gap: 8px; align-items: center; padding: 8px 0; border-top: 1px solid var(--line); }
  .alt .thumb { width: 40px; height: 40px; }
  .empty { color: var(--muted); font-size: 13px; }
`;

function constraintChips(candidate: ProductCandidate): string {
  const matched = candidate.matchedConstraints
    .map((c) => `<span class="chip matched">✓ ${escapeHtml(c)}</span>`)
    .join("");
  const uncertain = candidate.uncertainConstraints
    .map((c) => `<span class="chip uncertain">? ${escapeHtml(c)}</span>`)
    .join("");
  if (!matched && !uncertain) return "";
  return `<div class="chips">${matched}${uncertain}</div>`;
}

function variantLine(candidate: ProductCandidate): string {
  const options = Object.entries(candidate.selectedOptions)
    .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`)
    .join(" · ");
  return options ? `<div class="variant">${options}</div>` : "";
}

function actionForm(
  missionId: string,
  fields: Record<string, string>,
  label: string,
  primary: boolean,
): string {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  const action = escapeHtml(`/card/mission/${encodeURIComponent(missionId)}/action`);
  return `<form method="post" action="${action}">${inputs}<button${primary ? ' class="primary"' : ""}>${escapeHtml(label)}</button></form>`;
}

function slotSection(mission: ShoppingMission, slot: MissionSlot): string {
  const selected = selectedCandidate(slot);
  const alternatives = slot.candidates.filter((c) => c.variantId !== slot.selectedVariantId);

  const selectedHtml = selected
    ? `<div class="row">
        ${selected.imageUrl ? `<img class="thumb" src="${escapeHtml(selected.imageUrl)}" alt="">` : `<span class="thumb"></span>`}
        <div class="grow">
          <div>${escapeHtml(selected.title)}</div>
          <div class="seller">${escapeHtml(selected.sellerName)} · ${escapeHtml(selected.sellerDomain)}</div>
          ${variantLine(selected)}
          ${constraintChips(selected)}
        </div>
        <span class="price">${formatMoney(selected.price, selected.currency)}</span>
      </div>`
    : `<p class="empty">No item selected yet${slot.required ? " (required)" : ""}.</p>`;

  // A locked slot always gets an Unlock control — even with no selection —
  // so a stale lock can never leave the slot unrecoverable from the card.
  const lockControl = slot.locked
    ? actionForm(mission.id, { kind: "unlock", slotId: slot.id }, "Unlock", false)
    : selected
      ? actionForm(mission.id, { kind: "lock", slotId: slot.id }, "Lock", true)
      : "";

  const replaceControl =
    alternatives.length > 0 && !slot.locked
      ? `<details><summary>Replace</summary>${alternatives
          .map(
            (alt) => `<div class="alt">
              ${alt.imageUrl ? `<img class="thumb" src="${escapeHtml(alt.imageUrl)}" alt="">` : `<span class="thumb"></span>`}
              <div class="grow">
                <div>${escapeHtml(alt.title)}</div>
                <div class="seller">${escapeHtml(alt.sellerName)} · ${formatMoney(alt.price, alt.currency)}</div>
              </div>
              ${actionForm(mission.id, { kind: "select", slotId: slot.id, variantId: alt.variantId }, "Select", false)}
            </div>`,
          )
          .join("")}</details>`
      : "";

  return `<section class="card">
    <div class="sub">${escapeHtml(slot.label)}${slot.locked ? ` <span class="locked-tag">🔒 Locked</span>` : ""}</div>
    ${selectedHtml}
    <div class="actions">${lockControl}</div>
    ${replaceControl}
  </section>`;
}

export function renderMissionCard(mission: ShoppingMission): string {
  const total = missionSelectedTotal(mission);
  const ready = mission.slots.filter((s) => selectedCandidate(s)).length;
  const blockers = missionBlockers(mission);
  const over = total > mission.budget.amount;
  const pct = Math.min(100, Math.round((total / mission.budget.amount) * 100));
  const globals = [...mission.globalHardConstraints, ...mission.globalPreferences];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(mission.goal)}</title>
<style>${cardStyles}</style>
</head>
<body>
<main>
  <h1>${escapeHtml(mission.goal)}</h1>
  <div class="sub">${ready} / ${mission.slots.length} items ready · ${escapeHtml(mission.status)}</div>
  ${globals.length ? `<div class="chips">${globals.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join("")}</div>` : ""}
  <div class="card">
    <div class="row"><span class="grow">Budget</span>
      <span class="price">${formatMoney(total, mission.budget.currency)} / ${formatMoney(mission.budget.amount, mission.budget.currency)}</span>
    </div>
    <div class="bar${over ? " over" : ""}"><i style="width:${pct}%"></i></div>
  </div>
  ${blockers.length ? `<div class="blockers"><strong>Before checkout:</strong><ul>${blockers.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul></div>` : ""}
  ${mission.slots.map((slot) => slotSection(mission, slot)).join("")}
</main>
</body>
</html>`;
}
