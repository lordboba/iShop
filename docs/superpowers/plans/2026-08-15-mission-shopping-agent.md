# Mission Shopping Agent Implementation Plan (iMessage / Photon pivot)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a consumer shopping agent that lives in an iMessage thread. The buyer texts a multi-item goal (optionally with an inspiration photo); the agent turns it into a constraint-safe bundle from live Shopify inventory, renders the plan as a live-updating app card inside the thread, accepts revisions by text, and hands approved carts to Shopify-hosted checkout.

**Architecture:** One long-lived Node process runs two things: (1) a Photon Spectrum message loop that owns the conversation, and (2) a small Hono HTTP server that serves the mission/checkout card pages and JSON endpoints. The server holds a typed `ShoppingMission` per conversation space, uses OpenAI structured outputs to translate messages into mission changes, Shopify's UCP Global Catalog MCP to find products, a deterministic bundle optimizer to enforce hard constraints and total budget, and merchant Cart MCP to revalidate prices and create checkout handoffs. The mission board is a web page rendered *inside* the iMessage thread via Spectrum's `app(url, { live: true })` card, edited in place as the mission evolves. Payment stays on Shopify-hosted checkout.

**Why not Next.js/serverless:** Spectrum connects over a persistent gRPC stream, which requires a long-lived process. A plain Node service is simpler and honest about that constraint.

**Tech Stack:** Node 22 + TypeScript, Photon Spectrum (`spectrum-ts`), Hono, OpenAI Responses API (structured outputs), Shopify UCP/MCP APIs, Zod, Vitest (unit only), cloudflared/ngrok tunnel for public card URLs.

---

## Product thesis

Every AI shopping demo is a web chat with product cards. The memorable version of this product is **no new app at all**: you text a photo and a budget to a contact in iMessage, and a complete, purchasable, budget-correct outfit assembles itself inside the thread you already live in.

> Text: “Turn this photo into a rooftop-dinner outfit under $250. I wear M and 9.5, no leather, black or navy.” → the agent replies with a live mission card showing top / bottom / shoes / accessory filling in, a budget bar, and per-item provenance → “lock the jacket, find cheaper shoes” → only the shoes slot changes → “checkout” → merchant-grouped Shopify checkout links.

The demo's two hooks: (1) the surface — agentic commerce inside iMessage, which none of the incumbents demo; (2) the substance — deterministic bundle math (hard constraints, shared budget, locks) instead of a list of individually plausible products.

## Market map and differentiation

| Existing product/category | What already exists | Gap this demo targets |
|---|---|---|
| ChatGPT Shopping | Cross-merchant discovery from Shopify Catalog, checkout in an in-app browser | Lives in its own app; no multi-item mission optimization |
| Perplexity Instant Buy | NL research, product cards, eligible in-product purchases | No persistent hard constraints or bundle-level budget math |
| Google Universal Cart / Gemini | Cross-surface cart, price alerts, UCP checkout | No “brief → complete kit” workflow with locks/substitutions |
| Amazon Buy for Me | History-based recs, agentic purchase on some brand sites | Amazon-centric; no merchant-neutral Shopify selection |
| Shopify storefront chat apps | Single-store recommendations and checkout guidance | Single-merchant; no cross-merchant missions |
| All of the above | A destination app or website | **None of them live in the buyer's messaging thread** |

## MVP boundaries

Build only the buyer journey that wins a three-minute demo:

1. Receive one iMessage text (optionally with an attached inspiration photo).
2. Extract a mission with 2–5 required slots, a total budget, sizes, location, preferences.
3. Search Shopify's Global Catalog per slot.
4. Select a valid bundle under budget; render it as a live app card with explanations and uncertainty.
5. Accept text revisions: lock an item, replace an item, change the budget. Edit the card in place.
6. Revalidate selected variants through merchant carts.
7. On explicit “checkout”, send a checkout card with merchant-grouped Shopify-hosted checkout links.

Do not build: accounts, long-term memory, autonomous purchasing, card storage, returns, merchant dashboards, a web app, or multi-channel deployment (WhatsApp/Telegram are free later precisely because Spectrum is channel-agnostic — do not spend hackathon hours proving it).

**Interaction model constraint:** Spectrum's docs specify URL app cards and in-place `edit()`, but not tap-events flowing back to the agent loop. Therefore: **text is the primary control surface** (lock/replace/budget by chat), and buttons inside the card call our own HTTP API directly (the card is our web page). Card-button → conversation echo is a stretch goal, not the demo's critical path.

## Trust and checkout boundary

- The agent may search, rank, and mutate its proposed bundle without confirmation.
- The checkout card must show current merchant, variant, quantity, live subtotal, and any price change since selection.
- “Buy” means create/refresh carts and produce checkout handoff URLs. Never silently submit payment.
- The buyer must explicitly say “checkout” (or tap the checkout control) and then tap a merchant checkout link themselves.
- Never send card data through the model or store it in logs. Never log Photon project secrets or Shopify tokens.

## File structure

```text
src/
  index.ts                    # Boot: Spectrum loop + Hono server in one process
  agent/loop.ts               # Message loop: text/photo → mission actions → card updates
  agent/mission-parser.ts     # OpenAI structured-output calls (parse + revise)
  agent/prompts.ts            # Versioned mission-planning instructions
  domain/mission.ts           # Shared Zod schemas and inferred types
  state/mission-store.ts      # Per-space mission sessions + pure reducer
  optimizer/select-bundle.ts  # Deterministic budget/constraint optimizer
  shopify/auth.ts             # Catalog API token caching
  shopify/catalog.ts          # Global Catalog MCP adapter
  shopify/cart.ts             # Merchant Cart MCP adapter
  shopify/mcp-client.ts       # Small JSON-RPC client and errors
  shopify/types.ts            # Normalized catalog/cart types
  web/server.ts               # Hono: card pages, card API, UCP profile
  web/cards/mission.ts        # Server-rendered mission card HTML
  web/cards/checkout.ts       # Server-rendered checkout card HTML
tests/
  fixtures/shopify.ts         # Stable MCP response fixtures
  mission-parser.test.ts      # Structured mission parsing contract
  mission-store.test.ts       # Lock/revise/replace invariants
  select-bundle.test.ts       # Constraint and budget correctness
  shopify-catalog.test.ts     # MCP normalization and error handling
  shopify-cart.test.ts        # Cart grouping and price-change handling
.env.example                  # Required secret names only
README.md                     # Setup, demo script, safety boundary
```

Testing scope is deliberately unit-only: reducer, optimizer, parser contract, and adapter normalization are where correctness bugs kill the demo. No component tests, no Playwright — the end-to-end check is a scripted manual rehearsal through the terminal provider and a phone.

## Task 0: Prove BOTH external dependencies before building anything

Two hard external dependencies, both proven in hour one or the plan changes. Run the two halves in parallel if two people are available.

**Files:**
- Create: `.env.example`
- Create: `README.md`

- [ ] **Step 1: Record required secrets**

```dotenv
PHOTON_PROJECT_ID=
PHOTON_PROJECT_SECRET=
SHOPIFY_CATALOG_CLIENT_ID=
SHOPIFY_CATALOG_CLIENT_SECRET=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6-terra
PUBLIC_BASE_URL=            # cloudflared/ngrok tunnel URL for card pages
```

- [ ] **Step 2: Prove Photon end-to-end with an echo agent**

Create a Photon project at app.photon.codes, then in a scratch file:

```ts
import { Spectrum } from "spectrum-ts";
import { imessage, terminal } from "spectrum-ts/providers";

const app = await Spectrum({
  projectId: process.env.PHOTON_PROJECT_ID!,
  projectSecret: process.env.PHOTON_PROJECT_SECRET!,
  providers: [imessage.config(), terminal.config()],
});

for await (const [space, message] of app.messages) {
  if (message.content.type === "text") await space.send(`echo: ${message.content.text}`);
}
```

Expected: echo works in the terminal provider, then from a real iPhone over iMessage. Record round-trip latency. **If iMessage access is gated or flaky, fall back to Telegram via the same SDK and keep building — the code is identical.**

- [ ] **Step 3: Prove an app card renders in a thread**

Start a tunnel (`cloudflared tunnel --url http://localhost:3000`) serving any placeholder page, then send `app(PUBLIC_BASE_URL, { live: true })` from the echo agent. Expected: a tappable card appears in iMessage; note whether live rendering works on the test device or only a static preview (either is demoable; live is better).

- [ ] **Step 4: Prove Shopify global discovery**

```bash
npm install -g @shopify/ucp-cli
ucp profile init --name mission-shopper
ucp doctor
ucp catalog search \
  --set /query='black mens jacket under $100 no leather' \
  --set /context/address_country=US \
  --view :compact --format md
```

Expected: at least one live result with title, price, currency, variant ID, seller domain, and buy link.

- [ ] **Step 5: Prove cart handoff for one returned variant**

```bash
ucp cart create --business 'https://SELLER_DOMAIN' \
  --set /line_items/0/item/id='VARIANT_ID' \
  --set /line_items/0/quantity=1 \
  --set /context/address_country=US
```

Expected: cart ID, confirmed totals, `continue_url`. Record whether the merchant offers Cart MCP or only a buy-link permalink; the adapter must support both.

- [ ] **Step 6: Document the verified capability tier in README.md**

```markdown
| Capability | Verified | Demo behavior |
|---|---:|---|
| Photon iMessage delivery | yes/no | iMessage or Telegram fallback |
| Live app card rendering | yes/no | live card or static-preview card |
| Global catalog search | yes/no | live results or fixture mode |
| Merchant cart creation | yes/no | live cart or buy-link handoff |
| Checkout creation | yes/no | Shopify-hosted checkout |
```

- [ ] **Step 7: Commit the access contract**

```bash
git add .env.example README.md
git commit -m "docs: record Photon and Shopify capability contract"
```

## Task 1: Scaffold the typed service

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/index.ts`, `src/web/server.ts`

- [ ] **Step 1: Initialize the project**

```bash
npm init -y
npm install spectrum-ts hono @hono/node-server openai zod
npm install -D typescript tsx vitest @types/node
```

Scripts:

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Boot both halves in one process**

`src/index.ts` starts the Hono server on port 3000 and then enters the Spectrum message loop. Both share one in-memory `MissionStore`. Crash of either half must exit the process loudly (no zombie half-running agent).

- [ ] **Step 3: Verify**

Run `npm run typecheck && npm run dev`. Expected: server answers `GET /healthz`, terminal provider accepts a message.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src
git commit -m "chore: scaffold spectrum service"
```

## Task 2: Define the mission contract and store

**Files:**
- Create: `src/domain/mission.ts`
- Create: `src/state/mission-store.ts`
- Create: `tests/mission-store.test.ts`

- [ ] **Step 1: Write failing store tests (exactly these five invariants)**

```ts
it("keeps a locked selection when candidates are refreshed", () => {});
it("clears an unlocked selection when its slot constraints change", () => {});
it("recomputes the total from selected product prices", () => {});
it("blocks checkout when a required slot has no valid selection", () => {});
it("blocks checkout when the selected total exceeds the hard budget", () => {});
```

Run `npm test -- tests/mission-store.test.ts`; expected FAIL.

- [ ] **Step 2: Define shared schemas**

`ShoppingMission` uses integer minor currency units and explicit certainty:

```ts
import { z } from "zod";

export const productCandidateSchema = z.object({
  productId: z.string(),
  variantId: z.string(),
  title: z.string(),
  imageUrl: z.string().url().optional(),
  sellerName: z.string(),
  sellerDomain: z.string(),
  price: z.number().int().nonnegative(),
  currency: z.string().length(3),
  selectedOptions: z.record(z.string(), z.string()).default({}),
  buyUrl: z.string().url().optional(),
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
  budget: z.object({ amount: z.number().int().positive(), currency: z.string().length(3) }),
  globalHardConstraints: z.array(z.string()).default([]),
  globalPreferences: z.array(z.string()).default([]),
  slots: z.array(missionSlotSchema).min(1).max(5),
  status: z.enum(["draft", "searching", "ready", "checkout"]),
});
```

- [ ] **Step 3: Implement the store as a pure reducer plus a session map**

Actions: `missionParsed`, `searchStarted`, `candidatesLoaded`, `slotLocked`, `slotUnlocked`, `candidateSelected`, `slotRevised`, `checkoutStarted`. Selectors: `selectedProducts`, `selectedTotal`, `checkoutBlockers`. Sessions are keyed by Spectrum space ID (one mission per conversation; a new brief replaces the old mission). Never let the model calculate authoritative totals.

- [ ] **Step 4: Run tests (expect PASS) and commit**

```bash
git add src/domain src/state tests/mission-store.test.ts
git commit -m "feat: define shopping mission state contract"
```

## Task 3: Parse natural language into a bounded mission

**Files:**
- Create: `src/agent/prompts.ts`
- Create: `src/agent/mission-parser.ts`
- Create: `tests/mission-parser.test.ts`

- [ ] **Step 1: Write parser contract tests with an injected fake model client**

```ts
it("decomposes a complete outfit into no more than five purchasable slots", async () => {});
it("keeps allergy and material exclusions as hard constraints", async () => {});
it("converts a dollar budget to integer cents", async () => {});
it("rejects a mission with no budget instead of inventing one", async () => {});
it("classifies a follow-up message as a revision, not a new mission", async () => {});
```

Run and verify FAIL.

- [ ] **Step 2: Implement the prompt as policy**

```ts
export const MISSION_SYSTEM_PROMPT = `
Turn the buyer message into a shopping mission or a revision of the current mission.
- Create 1 to 5 independently purchasable slots.
- Preserve explicit budget, size, material, allergy, compatibility, and location constraints.
- Never invent a budget, size, deadline, or location.
- Put safety, allergy, size, material exclusions, and explicit maximum price in hard constraints.
- Put style, brand, color, and merchant-count preferences in soft preferences unless the buyer says "must".
- Search queries must describe products, not instructions to the shopper.
- Return only data matching the supplied schema.
`;
```

- [ ] **Step 3: Implement schema-constrained parsing and revision**

`parseMission(input, currentMission | null, client)` calls the Responses API with a Zod-derived JSON schema (`OPENAI_MODEL`, low reasoning effort). When a photo attachment is present, pass its URL as image input so the model can name slots from the inspiration image. Validate the result again locally, assign stable IDs server-side, return `{ mission, missingFields, intent: "create" | "revise" | "checkout" | "smalltalk" }`. Missing budget produces `missingFields: ["budget"]` so the agent asks one targeted question by text. Keep Shopify search and price arithmetic in direct code paths, never delegated to the model.

- [ ] **Step 4: Run tests (expect PASS, no live OpenAI call) and commit**

```bash
git add src/agent tests/mission-parser.test.ts
git commit -m "feat: parse buyer messages into shopping missions"
```

## Task 4: Build the Shopify UCP adapter

**Files:**
- Create: `src/shopify/{types,auth,mcp-client,catalog,cart}.ts`
- Create: `tests/fixtures/shopify.ts`, `tests/shopify-catalog.test.ts`, `tests/shopify-cart.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Catalog: one MCP response becomes `ProductCandidate[]`; prices stay integer minor units; seller domain and variant ID required; malformed offers dropped with a diagnostic, not a crash. Cart: selections grouped by `sellerDomain`; one cart call per merchant; changed live price yields a `priceChanges` entry; a variant missing from the refreshed cart is refused.

- [ ] **Step 2: Implement cached Catalog authentication**

`getCatalogAccessToken()` POSTs client credentials to `https://api.shopify.com/auth/access_token`, caches the bearer in module scope until 60s before JWT `exp`, throws a redacted `ShopifyAuthError`. Never log secrets.

- [ ] **Step 3: Implement a minimal MCP JSON-RPC client**

```ts
export async function callMcpTool<T>(input: {
  endpoint: string;
  tool: string;
  arguments: unknown;
  bearerToken?: string;
  profileUrl: string;
}): Promise<T>;
```

10-second timeout, JSON-RPC error parsing, typed tool content. The UCP agent profile is served at `GET /ucp/profile` on the Hono server, with URLs derived from `PUBLIC_BASE_URL` (the tunnel makes it publicly reachable in development).

- [ ] **Step 4: Implement catalog search and merchant carts**

`searchCatalog({ query, countryCode, imageUrl? })` calls `search_catalog`, then `get_product` only for top candidates needing variant detail; normalize at most six candidates per slot. `createMerchantCarts(products, countryCode)` prefers merchant Cart MCP; otherwise groups `buyUrl` values by seller and returns handoff-only carts. Return type distinguishes `mode: "cart" | "handoff"`.

- [ ] **Step 5: Run fixture tests (expect PASS), then ONE opt-in live smoke**

```bash
npm test -- tests/shopify-catalog.test.ts tests/shopify-cart.test.ts
SHOPIFY_LIVE_TEST=1 npm test -- tests/shopify-catalog.test.ts
```

Keep the live test skipped by default; do not rerun it on every change.

- [ ] **Step 6: Commit**

```bash
git add src/shopify tests/fixtures tests/shopify-catalog.test.ts tests/shopify-cart.test.ts src/web/server.ts
git commit -m "feat: connect Shopify catalog and cart capabilities"
```

## Task 5: Select a valid bundle deterministically

**Files:**
- Create: `src/optimizer/select-bundle.ts`
- Create: `tests/select-bundle.test.ts`

- [ ] **Step 1: Write failing optimizer tests**

```ts
it("selects one product per required slot without exceeding the total budget", () => {});
it("never selects a candidate with a known hard-constraint violation", () => {});
it("preserves locked selections during re-optimization", () => {});
it("prefers fewer merchants when relevance scores are otherwise equal", () => {});
it("returns an explicit infeasible result instead of dropping a required slot", () => {});
```

- [ ] **Step 2: Implement bounded exhaustive selection**

At most five slots × six candidates (≤7,776 combinations): prune hard violations, enumerate, score lexicographically — required slots filled → no hard violation → within budget → locked items preserved → relevance sum → fewer uncertain constraints → fewer merchants → lower total.

```ts
type BundleResult =
  | { status: "ready"; selections: Record<string, string>; total: number; merchantCount: number }
  | { status: "infeasible"; blockers: string[]; closestTotal?: number };
```

- [ ] **Step 3: Run tests (expect PASS) and commit**

```bash
git add src/optimizer tests/select-bundle.test.ts
git commit -m "feat: optimize complete shopping bundles"
```

## Task 6: The agent loop — conversation orchestration with progressive card updates

**Files:**
- Create: `src/agent/loop.ts`
- Modify: `src/index.ts`

This replaces the original plan's API route. It is the perceived-latency plan as much as the orchestration plan: a full parse + 4 slot searches + optimize can take 15–30s, which feels dead in a chat thread unless the card visibly fills in.

- [ ] **Step 1: Implement the message loop**

For each incoming message in a space:

1. Photos: capture attachment URL as inspiration input.
2. Send a typing indicator immediately.
3. `parseMission` with the space's current mission; on `missingFields`, reply with one targeted question and stop.
4. On `intent: "create"` — reply with a one-line acknowledgment, **immediately send the mission app card in `searching` state**, then search affected slots (concurrency 3), and `edit()` the card in place as each slot resolves and again when the optimizer finishes.
5. On `intent: "revise"` — search only changed/unlocked slots; never touch a locked slot; `edit()` the existing card.
6. On `intent: "checkout"` — hand off to Task 8's flow.
7. On a failed slot search — keep partial results, mark the slot as needing retry on the card, and say so in one line of text.

- [ ] **Step 2: Verify orchestration invariants with the existing unit surface**

Loop logic must stay thin: parse → store actions → search → optimize → card render. The store and optimizer tests already pin the invariants (locks survive, budget blocks checkout); do not duplicate them as loop tests. Manually verify in the terminal provider: brief → slots resolve → “lock the jacket” → “cheaper shoes” → only shoes change.

- [ ] **Step 3: Commit**

```bash
git add src/agent/loop.ts src/index.ts
git commit -m "feat: orchestrate missions from the message loop"
```

## Task 7: Mission and checkout cards

**Files:**
- Create: `src/web/cards/mission.ts`
- Create: `src/web/cards/checkout.ts`
- Modify: `src/web/server.ts`

- [ ] **Step 1: Serve the mission card page**

`GET /card/mission/:missionId` renders server-side HTML from the store: goal and constraints at top; completion count (`3 / 4 items ready`); budget bar (selected total vs cap); one row per slot with product image, title, price, seller, exact variant options, matched constraints, and uncertainty flags; visible checkout blockers. Design: warm neutral canvas, near-black type, one electric accent for locked/approved state, consistent image aspect ratio. It renders inside an iMessage card webview — design for a narrow viewport first.

- [ ] **Step 2: Card buttons hit our HTTP API directly**

`Lock` / `Replace` buttons on each row call `POST /card/mission/:missionId/action` and re-render. This works because the card is our page in a webview — it does not depend on Photon relaying tap events. After an action, the loop also `edit()`s the card message so the thread preview stays current. If live rendering proved unavailable in Task 0, the card opens as a normal page — same URL, same behavior.

- [ ] **Step 3: Serve the checkout card page**

`GET /card/checkout/:missionId` shows every merchant group, items with live subtotals, highlighted price changes, and one clearly-labeled `Open secure checkout` link per merchant pointing at Shopify/merchant-hosted payment.

- [ ] **Step 4: Verify in the terminal provider and a real thread, then commit**

```bash
git add src/web
git commit -m "feat: render mission and checkout cards"
```

## Task 8: Safe cart and checkout handoff

**Files:**
- Create: `src/agent/checkout.ts`
- Create: `tests/shopify-cart.test.ts` additions (checkout-boundary cases)

- [ ] **Step 1: Write checkout-boundary tests**

Cart creation requires a complete mission (no blockers); each selected variant is revalidated against live cart responses; live price changes are reported, never silently absorbed; approval is never derived from model output alone.

- [ ] **Step 2: Implement the checkout flow**

On `intent: "checkout"`: recompute `checkoutBlockers` — if any, reply with the blocker and stop. Otherwise rebuild products from the latest catalog/cart responses (accept variant IDs + country, never model-generated prices), create merchant carts, and produce:

```ts
type CheckoutPlan = {
  merchants: Array<{
    name: string;
    domain: string;
    items: Array<{ variantId: string; title: string; quantity: number; livePrice: number }>;
    subtotal: number;
    continueUrl: string;
    mode: "cart" | "handoff";
  }>;
  previousTotal: number;
  liveTotal: number;
  priceChanges: Array<{ variantId: string; before: number; after: number }>;
};
```

Send the checkout card plus a one-line text summary (`2 merchants, live total $237.50 — was $241.00`). If prices changed, say so explicitly before the buyer taps anything.

- [ ] **Step 3: Run tests (expect PASS) and commit**

```bash
git add src/agent/checkout.ts tests/shopify-cart.test.ts
git commit -m "feat: add explicit Shopify checkout handoff"
```

## Task 9: Fixture mode and demo rehearsal

**Files:**
- Modify: `src/shopify/catalog.ts`, `src/shopify/cart.ts`, `tests/fixtures/shopify.ts`
- Modify: `README.md`

- [ ] **Step 1: Add deterministic fixture mode**

`SHOPIFY_FIXTURE_MODE=1` makes both adapters return committed fixture data through the same interfaces. This is the stage fallback for Shopify outages; the Photon fallback is the Telegram provider (or opening card URLs directly in a browser) — both already exercised in Task 0.

- [ ] **Step 2: Run the focused verification set once**

```bash
npm test && npm run typecheck
```

Then one scripted rehearsal in the terminal provider with fixtures, and one live dress rehearsal from a real iPhone: submit the rooftop-outfit brief with a photo, watch four slots resolve on the card, lock the jacket, ask for cheaper shoes, verify total ≤ $250 and the jacket unchanged, say checkout, verify merchant groups and that one real checkout URL opens. Confirm no secret appears in any log.

- [ ] **Step 3: Write the three-minute pitch script into README.md**

```text
0:00 Problem: product search returns items; people shop for outcomes — and they shop from their phone, mid-conversation.
0:20 Brief: text the agent a photo + "rooftop outfit under $250, M, 9.5, no leather" in iMessage.
0:45 Plan: the mission card appears in the thread and fills in live — slots, hard constraints, shared budget bar.
1:20 Agency: "lock the jacket, cheaper shoes" — one slot changes, the lock holds, the budget stays correct.
1:55 Trust: uncertainty flags, merchant provenance, live price revalidation on the card.
2:20 Commerce: "checkout" — merchant-grouped card, tap into real Shopify checkout.
2:45 Close: any text thread can now turn intent into a complete, auditable, purchasable mission.
```

- [ ] **Step 4: Commit**

```bash
git add README.md src tests
git commit -m "test: add fixture mode and demo rehearsal script"
```

## Stretch features, in priority order

1. Card-tap → conversation echo (a tapped `Replace` also posts a visible confirmation into the thread), if Photon exposes interaction events.
2. Image search against Shopify Global Catalog's image endpoint (beyond using the photo for slot naming).
3. `Why this bundle?` comparison against the next-best feasible combination.
4. Group-chat missions: two people in one thread revising a shared mission (Spectrum supports group chats natively — high demo value if time allows).
5. Order lookup after checkout, if the granted capability tier supports it.

## Go/no-go checkpoints

- **By hour 1:** Photon echo works in a real iMessage thread AND a UCP catalog query returns real products. If iMessage is gated → Telegram provider. If catalog fails → Storefront API against a dev store + fixture mode.
- **By hour 2:** an app card from our tunnel renders in the thread.
- **By hour 4:** a mission decomposes into slots and renders fixture candidates on the card.
- **By hour 6:** deterministic bundle selection and text-driven lock/replace work end to end.
- **By hour 8:** at least one real merchant cart or buy-link handoff works from the checkout card.
- **Final two hours:** stop adding features; rehearse the live phone path and the fixture/terminal fallback; polish only what appears in the pitch.

## Source references checked on 2026-08-15

- [Photon platform](https://photon.codes) and [Spectrum docs](https://photon.codes/docs/) — `spectrum-ts` quickstart, providers, message loop
- [Spectrum app cards](https://photon.codes/docs/spectrum-ts/content/app) — `app(url, { live })`, in-place `edit()`, iMessage-only live rendering
- [Spectrum terminal provider](https://photon.codes/docs/spectrum-ts/providers/terminal/setup-and-usage) — local development loop
- [Shopify agentic commerce overview](https://shopify.dev/docs/agents)
- [Shopify UCP quickstart](https://shopify.dev/docs/agents/get-started/quickstart)
- [Shopify Global Catalog MCP](https://shopify.dev/docs/agents/catalog/global-catalog)
- [Shopify Storefront cart and checkout URL](https://shopify.dev/docs/storefronts/headless/building-with-the-storefront-api/cart/manage)
- [OpenAI model guidance for Responses API workflows](https://developers.openai.com/api/docs/guides/latest-model)
