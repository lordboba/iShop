# Mission Shopping Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a consumer shopping agent that turns a multi-item goal into a constraint-safe bundle, searches live Shopify inventory, lets the buyer revise or approve the whole plan, and hands the approved carts to Shopify checkout.

**Architecture:** A Next.js application owns a typed `ShoppingMission` and renders it as a live mission board beside the conversation. The server uses OpenAI structured outputs to translate conversation into mission changes, Shopify's UCP-compliant Global Catalog MCP to find products, a deterministic bundle optimizer to enforce hard constraints and total budget, and merchant-scoped Cart/Checkout MCP endpoints to validate prices and create checkout handoffs. Payment remains on Shopify's hosted checkout unless the hackathon account is explicitly granted trusted checkout completion.

**Tech Stack:** Next.js App Router, React, TypeScript, Tailwind CSS, OpenAI Responses API, Shopify UCP/MCP APIs, Zod, Vitest, Testing Library, Playwright

---

## Product thesis

Current AI shopping products already do conversational discovery, product cards, visual search, comparisons, and—on selected merchants—checkout. A generic “tell me what to buy” chatbot will look interchangeable.

The demo should instead sell an outcome:

> “Turn this reference image into a complete rooftop-dinner outfit under $250. I wear M and 9.5, avoid leather, and prefer black or navy.”

The product creates explicit slots such as top, bottom, shoes, and optional accessory; searches each slot; chooses a coherent combination under one shared budget; exposes any violated or uncertain constraint; lets the user lock or replace individual choices; creates live merchant carts; then asks for one final approval before checkout.

The memorable interaction is not the chat. It is watching an incomplete mission become a complete, purchasable plan while the total budget and constraints remain correct.

## Market map and differentiation

| Existing product/category | What already exists | Gap this demo targets |
|---|---|---|
| ChatGPT Shopping | Cross-merchant discovery from Shopify Catalog and merchant checkout in an in-app browser | Optimize and manage a complete multi-item mission, not a list of individually relevant products |
| Perplexity Instant Buy | Natural-language research, product cards, saved checkout details, and eligible in-product purchases | Persistent hard constraints and transparent bundle-level tradeoffs |
| Google Universal Cart / Gemini | Cross-surface cart, price alerts, compatibility insights, loyalty, and UCP checkout | A focused, interactive “brief to complete kit” workflow with user-controlled locks and substitutions |
| Amazon Alexa for Shopping / Buy for Me | Recommendations using history plus agentic purchase from some brand sites | Merchant-neutral Shopify selection and an auditable reason for every chosen item |
| Shopify storefront chat apps | Single-store recommendations, support answers, and checkout guidance | Cross-merchant missions and deterministic total-budget enforcement |
| Visual-search apps | Find visually similar individual products | Decompose one inspiration image into a coordinated, complete, purchasable bundle |

## MVP boundaries

Build only the buyer journey that can win a three-minute demo:

1. Accept one text request and an optional image URL.
2. Extract a mission with 2–5 required slots, a total budget, sizes, location, and preferences.
3. Search Shopify's Global Catalog for candidates per slot.
4. Select a valid bundle under budget and show explanations plus uncertainty.
5. Let the user lock an item, replace an item, or change the budget.
6. Revalidate selected variants through merchant carts.
7. Require explicit approval, then open Shopify-hosted checkout.

Do not build accounts, long-term memory, autonomous background purchasing, payment-card storage, returns, merchant dashboards, or a general-purpose browser agent for the MVP.

## Trust and checkout boundary

- The agent may search, rank, and mutate its proposed bundle without confirmation.
- The agent must show current merchant, variant, quantity, subtotal, and any price change before checkout.
- “Buy” means create/refresh carts and obtain checkout handoff URLs. It does not mean silently submit payment.
- The buyer must click a final `Review & checkout` control.
- If Shopify grants trusted checkout completion, add it only as a stretch path with a second, explicit `Place order` confirmation.
- Never send card data through the model or store it in application logs.

## File structure

```text
app/
  api/agent/route.ts                 # Parse/revise missions and orchestrate catalog searches
  api/cart/route.ts                  # Revalidate variants and create merchant carts
  api/ucp/profile/route.ts           # Public UCP agent profile
  globals.css                        # Design tokens and page-level styling
  layout.tsx                         # Root metadata and shell
  page.tsx                           # Main mission workspace
components/
  composer.tsx                       # Text and image input
  mission-board.tsx                  # Slots, progress, totals, and approval state
  mission-header.tsx                 # Goal and editable global constraints
  product-card.tsx                   # Candidate/selected product with evidence
  slot-card.tsx                      # Lock, replace, and uncertainty controls
  checkout-sheet.tsx                # Merchant grouping and final approval
lib/
  agent/mission-parser.ts            # OpenAI structured-output call
  agent/prompts.ts                   # Versioned mission-planning instructions
  domain/mission.ts                  # Shared Zod schemas and inferred types
  optimizer/select-bundle.ts         # Deterministic budget/constraint optimizer
  shopify/auth.ts                    # Catalog API token caching
  shopify/catalog.ts                 # Global Catalog MCP adapter
  shopify/cart.ts                    # Merchant Cart MCP adapter
  shopify/mcp-client.ts              # Small JSON-RPC client and errors
  shopify/types.ts                   # Normalized catalog/cart types
  state/mission-reducer.ts           # Client state transitions
tests/
  agent-route.test.ts                # Orchestration, partial failure, and lock behavior
  cart-route.test.ts                 # Checkout approval and price revalidation
  fixtures/shopify.ts                # Stable MCP response fixtures
  mission-parser.test.ts             # Structured mission parsing contract
  mission-reducer.test.ts            # Lock/revise/replace behavior
  select-bundle.test.ts              # Constraint and budget correctness
  shopify-catalog.test.ts            # MCP normalization and error handling
  shopify-cart.test.ts               # Cart grouping and price-change handling
  mission-flow.spec.ts               # Browser-level happy path
.env.example                         # Required secret names only
README.md                            # Setup, demo script, and safety boundary
```

## Task 0: Prove Shopify access before building UI

**Files:**
- Create: `.env.example`
- Create: `README.md`

- [ ] **Step 1: Generate Catalog API credentials**

In Shopify's Dev Dashboard, open **Catalogs**, create an API key, and keep the client ID and secret outside Git. Add only the variable names:

```dotenv
SHOPIFY_CATALOG_CLIENT_ID=
SHOPIFY_CATALOG_CLIENT_SECRET=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6-terra
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

- [ ] **Step 2: Install the Shopify UCP CLI and initialize a local profile**

Run:

```bash
npm install -g @shopify/ucp-cli
ucp profile init --name mission-shopper
ucp doctor
```

Expected: `ucp doctor` reports a healthy active profile.

- [ ] **Step 3: Prove global discovery with a real query**

Run:

```bash
ucp catalog search \
  --set /query='black mens jacket under $100 no leather' \
  --set /context/address_country=US \
  --view :compact \
  --format md
```

Expected: at least one live result containing a title, price, currency, variant ID, seller domain, and buy link. If this fails, stop feature work and repair credentials/profile access first.

- [ ] **Step 4: Prove cart handoff for one returned variant**

Run with a seller domain and variant ID from Step 3:

```bash
ucp cart create --business 'https://SELLER_DOMAIN' \
  --set /line_items/0/item/id='VARIANT_ID' \
  --set /line_items/0/quantity=1 \
  --set /context/address_country=US
```

Expected: a cart ID, confirmed totals, and a `continue_url`. Record whether the merchant offers Cart MCP or only a product/cart permalink; the adapter must support both.

- [ ] **Step 5: Document the verified capability tier**

Add this table to `README.md` with observed values rather than guesses:

```markdown
| Capability | Verified | Demo behavior |
|---|---:|---|
| Global catalog search | yes/no | live results or fixture mode |
| Merchant cart creation | yes/no | live cart or buy-link handoff |
| Checkout creation | yes/no | Shopify-hosted checkout |
| Trusted checkout completion | yes/no | disabled unless explicitly granted |
| Order lookup | yes/no | live status or omitted from MVP |
```

- [ ] **Step 6: Commit the access contract**

```bash
git add .env.example README.md
git commit -m "docs: record Shopify agent capability contract"
```

## Task 1: Scaffold the typed application

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `postcss.config.mjs`
- Create: `app/layout.tsx`
- Create: `app/page.tsx`
- Create: `app/globals.css`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create the Next.js project in the existing directory**

Run:

```bash
npx create-next-app@latest . --ts --tailwind --eslint --app --src-dir=false --import-alias='@/*'
npm install openai zod
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom playwright
```

Expected: the app scaffolds without nesting another Git repository.

- [ ] **Step 2: Add focused test scripts**

Set the `package.json` scripts to include:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "lint": "eslint .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  }
}
```

- [ ] **Step 3: Replace the starter page with a two-pane shell**

The root page should render a narrow conversation rail and a wider mission board, collapsing to one column below 900px. Keep the initial state useful:

```tsx
export default function HomePage() {
  return (
    <main className="workspace">
      <section aria-label="Shopping conversation" className="conversation" />
      <section aria-label="Mission plan" className="mission" />
    </main>
  );
}
```

- [ ] **Step 4: Verify the empty shell**

Run:

```bash
npm run lint
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the scaffold**

```bash
git add package.json package-lock.json tsconfig.json next.config.ts postcss.config.mjs app vitest.config.ts
git commit -m "chore: scaffold mission shopping workspace"
```

## Task 2: Define the mission contract and reducer

**Files:**
- Create: `lib/domain/mission.ts`
- Create: `lib/state/mission-reducer.ts`
- Create: `tests/mission-reducer.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Cover these exact behaviors:

```ts
it("keeps a locked selection when candidates are refreshed", () => {});
it("clears an unlocked selection when its slot constraints change", () => {});
it("recomputes the total from selected product prices", () => {});
it("blocks checkout when a required slot has no valid selection", () => {});
it("blocks checkout when the selected total exceeds the hard budget", () => {});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `npm test -- tests/mission-reducer.test.ts`

Expected: FAIL because the schema and reducer do not exist.

- [ ] **Step 3: Define shared schemas**

`ShoppingMission` must use integer minor currency units and explicit certainty:

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

export type ShoppingMission = z.infer<typeof shoppingMissionSchema>;
export type MissionSlot = z.infer<typeof missionSlotSchema>;
export type ProductCandidate = z.infer<typeof productCandidateSchema>;
```

- [ ] **Step 4: Implement reducer invariants**

Support only explicit actions: `missionParsed`, `searchStarted`, `candidatesLoaded`, `slotLocked`, `slotUnlocked`, `candidateSelected`, `slotRevised`, and `checkoutStarted`. Export selectors `selectedProducts`, `selectedTotal`, and `checkoutBlockers`; never let the model calculate authoritative totals.

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/mission-reducer.test.ts`

Expected: PASS for all five invariants.

- [ ] **Step 6: Commit**

```bash
git add lib/domain/mission.ts lib/state/mission-reducer.ts tests/mission-reducer.test.ts
git commit -m "feat: define shopping mission state contract"
```

## Task 3: Parse natural language into a bounded mission

**Files:**
- Create: `lib/agent/prompts.ts`
- Create: `lib/agent/mission-parser.ts`
- Create: `tests/mission-parser.test.ts`

- [ ] **Step 1: Write parser contract tests with an injected model client**

Use a fake response and assert:

```ts
it("decomposes a complete outfit into no more than five purchasable slots", async () => {});
it("keeps allergy and material exclusions as hard constraints", async () => {});
it("converts a dollar budget to integer cents", async () => {});
it("rejects a mission with no budget instead of inventing one", async () => {});
```

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- tests/mission-parser.test.ts`

Expected: FAIL because `parseMission` does not exist.

- [ ] **Step 3: Implement the prompt as policy, not prose UI**

The system prompt must include these rules:

```ts
export const MISSION_SYSTEM_PROMPT = `
Turn the buyer request into a shopping mission.
- Create 1 to 5 independently purchasable slots.
- Preserve explicit budget, size, material, allergy, compatibility, and location constraints.
- Never invent a budget, size, deadline, or location.
- Put safety, allergy, size, material exclusions, and explicit maximum price in hard constraints.
- Put style, brand, color, and merchant-count preferences in soft preferences unless the buyer says "must".
- Search queries must describe products, not instructions to the shopper.
- Return only data matching the supplied schema.
`;
```

- [ ] **Step 4: Implement schema-constrained parsing**

`parseMission(input, client)` should call the Responses API with a Zod-derived JSON schema, using the configurable `OPENAI_MODEL` value and low reasoning effort as the latency baseline. Validate the result again locally, assign stable IDs on the server, and return `{ mission, missingFields }`. Missing budget produces `missingFields: ["budget"]` so the UI can ask one targeted question. Keep Shopify search and authoritative price arithmetic as direct code paths rather than delegating them to the model.

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/mission-parser.test.ts`

Expected: PASS without a live OpenAI request.

- [ ] **Step 6: Commit**

```bash
git add lib/agent tests/mission-parser.test.ts
git commit -m "feat: parse buyer requests into shopping missions"
```

## Task 4: Build the Shopify UCP adapter

**Files:**
- Create: `lib/shopify/types.ts`
- Create: `lib/shopify/auth.ts`
- Create: `lib/shopify/mcp-client.ts`
- Create: `lib/shopify/catalog.ts`
- Create: `lib/shopify/cart.ts`
- Create: `tests/fixtures/shopify.ts`
- Create: `tests/shopify-catalog.test.ts`
- Create: `tests/shopify-cart.test.ts`
- Create: `app/api/ucp/profile/route.ts`

- [ ] **Step 1: Write catalog normalization tests**

Assert that one MCP response becomes `ProductCandidate[]`, prices remain integer minor units, seller domain and variant ID are required, and malformed offers are dropped with a diagnostic rather than crashing the whole search.

- [ ] **Step 2: Write cart tests**

Assert that selected products are grouped by `sellerDomain`, each merchant gets its own cart call, a changed live price returns a `priceChanges` entry, and the route refuses a variant missing from the refreshed cart response.

- [ ] **Step 3: Verify both suites fail**

Run:

```bash
npm test -- tests/shopify-catalog.test.ts tests/shopify-cart.test.ts
```

Expected: FAIL because adapters do not exist.

- [ ] **Step 4: Implement cached Catalog authentication**

`getCatalogAccessToken()` should POST client credentials to `https://api.shopify.com/auth/access_token`, cache the bearer token in module scope until 60 seconds before its JWT `exp`, and throw a redacted `ShopifyAuthError`. Never log the client secret or bearer token.

- [ ] **Step 5: Implement a minimal MCP JSON-RPC client**

Expose one function:

```ts
export async function callMcpTool<T>(input: {
  endpoint: string;
  tool: string;
  arguments: unknown;
  bearerToken?: string;
  profileUrl: string;
}): Promise<T>;
```

It must send the UCP agent profile metadata, impose a 10-second timeout, parse JSON-RPC errors, and return typed tool content. Keep all protocol details out of the route handlers.

- [ ] **Step 6: Implement Global Catalog search**

Expose `searchCatalog({ query, countryCode, imageUrl? })`. Call `search_catalog`, then use `get_product` only for the top candidates that need variant details. Normalize at most six candidates per slot to keep latency and model context bounded.

- [ ] **Step 7: Implement merchant cart creation with fallback**

Expose `createMerchantCarts(products, countryCode)`. Prefer merchant Cart MCP when advertised. If unavailable, group selected `buyUrl` values by seller and return handoff-only carts. The return type must distinguish `mode: "cart" | "handoff"`.

- [ ] **Step 8: Host the UCP profile**

`GET /api/ucp/profile` should return the advertised catalog, cart, checkout, and order capabilities supported by this app, with the production URL derived from `NEXT_PUBLIC_APP_URL`. In development, the CLI profile remains the source for direct experiments; deployed MCP calls require a publicly reachable profile URL.

- [ ] **Step 9: Run adapter tests**

Run:

```bash
npm test -- tests/shopify-catalog.test.ts tests/shopify-cart.test.ts
```

Expected: PASS using fixtures only.

- [ ] **Step 10: Run one opt-in live smoke test**

Run: `SHOPIFY_LIVE_TEST=1 npm test -- tests/shopify-catalog.test.ts`

Expected: one real query returns at least one normalized candidate. Keep this test skipped by default so routine validation is fast and deterministic.

- [ ] **Step 11: Commit**

```bash
git add lib/shopify app/api/ucp/profile/route.ts tests/fixtures tests/shopify-catalog.test.ts tests/shopify-cart.test.ts
git commit -m "feat: connect Shopify catalog and cart capabilities"
```

## Task 5: Select a valid bundle deterministically

**Files:**
- Create: `lib/optimizer/select-bundle.ts`
- Create: `tests/select-bundle.test.ts`

- [ ] **Step 1: Write failing optimizer tests**

Cover:

```ts
it("selects one product per required slot without exceeding the total budget", () => {});
it("never selects a candidate with a known hard-constraint violation", () => {});
it("preserves locked selections during re-optimization", () => {});
it("prefers fewer merchants when relevance scores are otherwise equal", () => {});
it("returns an explicit infeasible result instead of dropping a required slot", () => {});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/select-bundle.test.ts`

Expected: FAIL because `selectBundle` does not exist.

- [ ] **Step 3: Implement bounded exhaustive selection**

With at most five slots and six candidates per slot, enumerate valid combinations after pruning known hard violations. Score combinations in this order:

1. all required slots filled;
2. no hard-constraint violation;
3. total at or below budget;
4. locked items preserved;
5. semantic relevance sum;
6. fewer uncertain constraints;
7. fewer merchants;
8. lower total price.

Return:

```ts
type BundleResult =
  | { status: "ready"; selections: Record<string, string>; total: number; merchantCount: number }
  | { status: "infeasible"; blockers: string[]; closestTotal?: number };
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/select-bundle.test.ts`

Expected: PASS, including locked-item and infeasible cases.

- [ ] **Step 5: Commit**

```bash
git add lib/optimizer tests/select-bundle.test.ts
git commit -m "feat: optimize complete shopping bundles"
```

## Task 6: Orchestrate mission creation and revision

**Files:**
- Create: `app/api/agent/route.ts`
- Modify: `lib/agent/mission-parser.ts`
- Create: `tests/agent-route.test.ts`

- [ ] **Step 1: Write route tests**

Test three actions: `createMission`, `reviseMission`, and `replaceSlot`. Assert that the route searches only changed/unlocked slots, bounds concurrent catalog calls to three, returns partial results when one slot search fails, and never changes a locked slot.

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/agent-route.test.ts`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement a single orchestration route**

The route should:

1. validate the request body;
2. parse or revise the mission;
3. return a clarification response if required fields are absent;
4. search only affected slots with a concurrency limit of three;
5. attach normalized candidates;
6. call `selectBundle`;
7. return the complete mission plus diagnostics.

Return structured events, not generated UI prose:

```ts
type AgentResponse =
  | { kind: "clarification"; question: string; field: string }
  | { kind: "mission"; mission: ShoppingMission; diagnostics: string[] }
  | { kind: "error"; retryable: boolean; message: string };
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/agent-route.test.ts`

Expected: PASS with injected fake model and Shopify clients.

- [ ] **Step 5: Commit**

```bash
git add app/api/agent/route.ts lib/agent/mission-parser.ts tests/agent-route.test.ts
git commit -m "feat: orchestrate mission search and revision"
```

## Task 7: Build the mission-first interface

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Create: `components/composer.tsx`
- Create: `components/mission-board.tsx`
- Create: `components/mission-header.tsx`
- Create: `components/product-card.tsx`
- Create: `components/slot-card.tsx`
- Create: `tests/mission-board.test.tsx`

- [ ] **Step 1: Write interaction tests**

Test that submitting a brief renders slots, totals are visible without opening chat history, locking a slot changes its control state, replacing one slot does not blank the board, and checkout remains disabled while blockers exist.

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/mission-board.test.tsx`

Expected: FAIL because the UI components do not exist.

- [ ] **Step 3: Implement the composer**

The initial composer should include one strong example prompt, text input, optional image URL/upload preview, and one primary `Build my plan` action. Do not lead with a blank generic chatbot.

- [ ] **Step 4: Implement the persistent mission board**

Show:

- goal and editable global constraints at the top;
- completion count such as `3 / 4 items ready`;
- budget bar using selected total versus cap;
- one card per slot with selected product, price, seller, exact variant options, matched constraints, and uncertainty;
- `Lock`, `Replace`, and candidate-navigation controls;
- an always-visible checkout blocker or primary action.

- [ ] **Step 5: Apply a restrained visual system**

Use a warm neutral canvas, near-black type, one electric accent for active/approved state, product imagery with consistent aspect ratio, and motion only when a slot resolves or changes. Avoid gradients, excessive pills, and chat bubbles for machine-generated status.

- [ ] **Step 6: Run component tests and lint**

Run:

```bash
npm test -- tests/mission-board.test.tsx
npm run lint
```

Expected: PASS and lint exits 0.

- [ ] **Step 7: Commit**

```bash
git add app/page.tsx app/globals.css components tests/mission-board.test.tsx
git commit -m "feat: add mission-first shopping interface"
```

## Task 8: Add safe cart and checkout handoff

**Files:**
- Create: `app/api/cart/route.ts`
- Create: `components/checkout-sheet.tsx`
- Create: `tests/cart-route.test.ts`

- [ ] **Step 1: Write checkout-boundary tests**

Assert that cart creation requires a complete mission, revalidates each selected variant, reports live price changes, groups checkout links by merchant, and never returns `approved: true` based only on an agent/model message.

- [ ] **Step 2: Verify failure**

Run: `npm test -- tests/cart-route.test.ts`

Expected: FAIL because the cart route does not exist.

- [ ] **Step 3: Implement the cart route**

Accept the selected variant IDs plus country code—not model-generated prices. Rebuild products from the latest catalog/cart responses, create merchant carts, and return:

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

- [ ] **Step 4: Implement final approval UI**

The checkout sheet must show every merchant, item, and live subtotal; highlight price changes; and require a user click on `Open secure checkout`. Open merchant checkouts one at a time to avoid popup blocking. Label the redirect clearly as Shopify/merchant-hosted payment.

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/cart-route.test.ts`

Expected: PASS for incomplete mission, price-change, fallback, and happy paths.

- [ ] **Step 6: Commit**

```bash
git add app/api/cart/route.ts components/checkout-sheet.tsx tests/cart-route.test.ts
git commit -m "feat: add explicit Shopify checkout handoff"
```

## Task 9: Verify the complete demo story

**Files:**
- Create: `tests/mission-flow.spec.ts`
- Modify: `README.md`
- Modify: `lib/shopify/catalog.ts`
- Modify: `lib/shopify/cart.ts`
- Modify: `tests/fixtures/shopify.ts`

- [ ] **Step 1: Add a deterministic fixture mode**

When `SHOPIFY_FIXTURE_MODE=1`, adapters should return committed fixture data through the same interfaces as live mode. This is the stage-demo fallback, not a separate mock UI.

- [ ] **Step 2: Write one Playwright story**

Automate exactly this flow:

```text
Submit: “Build a four-piece black/navy rooftop outfit under $250. Men's M,
shoes 9.5, no leather.”
Wait for four resolved slots.
Lock the jacket.
Replace the shoes with a cheaper option.
Verify total <= $250 and jacket unchanged.
Open checkout review.
Verify merchant groups and explicit approval control.
```

- [ ] **Step 3: Run the focused verification set once**

Run:

```bash
npm test
SHOPIFY_FIXTURE_MODE=1 npm run test:e2e
npm run build
```

Expected: unit tests pass, the one end-to-end story passes, and production build exits 0. Do not repeatedly rerun the live Shopify smoke test unless credentials or adapter code changed.

- [ ] **Step 4: Perform one live manual dress rehearsal**

Use the same prompt against live Shopify data. Confirm product images render, selected variants exist, total arithmetic matches Shopify responses, at least one checkout URL opens, and no secret/token appears in browser or server logs.

- [ ] **Step 5: Add a three-minute pitch script**

Document:

```text
0:00 Problem: product search returns items; people shop for outcomes.
0:25 Brief: submit the rooftop-outfit mission and optional inspiration image.
0:50 Plan: show slot decomposition, hard constraints, and shared budget.
1:20 Agency: lock the jacket and ask for cheaper shoes; watch only one slot change.
1:55 Trust: show uncertainty, merchant provenance, and live price revalidation.
2:20 Commerce: approve the bundle and open real Shopify checkout.
2:45 Close: any intent becomes a complete, auditable, purchasable mission.
```

- [ ] **Step 6: Commit verification and demo docs**

```bash
git add tests/mission-flow.spec.ts README.md
git commit -m "test: verify end-to-end shopping mission"
```

## Stretch features, in priority order

1. Image input to Shopify Global Catalog's image search for inspiration-led missions.
2. `Why this bundle?` comparison against the next-best feasible combination.
3. Order lookup after completed checkout when the granted capability tier supports it.
4. Saved buyer preferences via explicit opt-in local profile.
5. Trusted checkout completion only after Shopify grants the required trust tier and a second approval boundary is implemented.
6. Universal Cart early access; do not block the MVP on it.

## Go/no-go checkpoints

- By hour 1: global catalog query returns real products. Otherwise switch immediately to Storefront API against a known development store plus fixture mode.
- By hour 3: one mission decomposes into slots and renders fixture candidates.
- By hour 5: deterministic bundle selection and lock/replace work.
- By hour 7: at least one real merchant cart or buy-link handoff works.
- Final two hours: stop adding features; rehearse the live and fixture paths, polish only the screens shown in the pitch.

## Source references checked on 2026-08-15

- [Shopify agentic commerce overview](https://shopify.dev/docs/agents)
- [Shopify UCP quickstart](https://shopify.dev/docs/agents/get-started/quickstart)
- [Shopify Global Catalog MCP](https://shopify.dev/docs/agents/catalog/global-catalog)
- [Shopify Storefront cart and checkout URL](https://shopify.dev/docs/storefronts/headless/building-with-the-storefront-api/cart/manage)
- [OpenAI product discovery and Shopify Catalog integration](https://openai.com/index/powering-product-discovery-in-chatgpt/)
- [OpenAI model guidance for Responses API workflows](https://developers.openai.com/api/docs/guides/latest-model)
- [Perplexity Instant Buy](https://www.perplexity.ai/help-center/en/articles/10352906-what-is-instant-buy)
- [Amazon AI shopping and Buy for Me](https://www.aboutamazon.com/news/retail/amazon-agentic-ai-gen-ai-shopping)
- [Google Universal Cart and UCP updates](https://blog.google/products-and-platforms/products/shopping/shopping-updates-google-marketing-live/)
