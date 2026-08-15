# Module contracts

Fixed interfaces between modules so they can be built in parallel. Every module
imports domain types ONLY from `src/domain/mission.ts` (already written — do not
modify it). Tests use `bun:test` (`import { describe, it, expect } from "bun:test"`).
Runtime is Bun; HTTP is Hono served via `Bun.serve({ fetch: app.fetch, port })`.

## src/state/mission-store.ts

```ts
export type MissionAction =
  | { type: "missionParsed"; mission: ShoppingMission }
  | { type: "searchStarted"; slotIds: string[] }
  | { type: "candidatesLoaded"; slotId: string; candidates: ProductCandidate[] }
  | { type: "slotLocked"; slotId: string }
  | { type: "slotUnlocked"; slotId: string }
  | { type: "candidateSelected"; slotId: string; variantId: string }
  | { type: "slotRevised"; slotId: string; query: string; hardConstraints: string[]; softPreferences: string[] }
  | { type: "checkoutStarted" };

export function reduceMission(mission: ShoppingMission, action: MissionAction): ShoppingMission; // pure
export function selectedProducts(mission: ShoppingMission): ProductCandidate[];
export function selectedTotal(mission: ShoppingMission): number;
export function checkoutBlockers(mission: ShoppingMission): string[]; // [] means checkout may proceed

export class MissionStore {
  // one mission per conversation space; missions also addressable by mission.id
  getBySpace(spaceId: string): ShoppingMission | null;
  getByMissionId(missionId: string): ShoppingMission | null;
  spaceIdForMission(missionId: string): string | null;
  put(spaceId: string, mission: ShoppingMission): void;
  dispatch(spaceId: string, action: MissionAction): ShoppingMission; // throws if no mission
  putCheckoutPlan(missionId: string, plan: CheckoutPlan): void;
  getCheckoutPlan(missionId: string): CheckoutPlan | null;
}
```

Invariants (tested): locked selections survive `candidatesLoaded`; `slotRevised`
clears an unlocked selection and its candidates; totals come only from selected
candidate prices; `checkoutBlockers` reports unfilled required slots and
over-budget totals.

## src/optimizer/select-bundle.ts

```ts
export function selectBundle(mission: ShoppingMission): BundleResult;
```

Bounded exhaustive: ≤5 slots × ≤6 candidates. Prune candidates whose
`uncertainConstraints`/violations include a hard constraint violation (a
candidate "violates" when a hard constraint appears in neither
`matchedConstraints` nor `uncertainConstraints` — treat unmatched-and-uncertain
per plan: unmatched hard constraint = pruned; uncertain = allowed but scored
down). Lexicographic score: required filled → no hard violation → within budget
→ locked preserved → relevance (candidate order = relevance rank) → fewer
uncertain → fewer merchants → lower total. Locked slots MUST keep their
selected variant or return infeasible.

## src/agent/mission-parser.ts + src/agent/prompts.ts

```ts
export interface MissionModelClient {
  // returns JSON matching the provided JSON schema (already parsed)
  complete(args: { system: string; user: string; imageUrl?: string; schema: Record<string, unknown> }): Promise<unknown>;
}
export function createOpenAIMissionClient(): MissionModelClient; // OPENAI_API_KEY, OPENAI_MODEL (default "gpt-5.6-luna"), Responses API
export type ParseResult = {
  intent: "create" | "revise" | "checkout" | "smalltalk";
  mission: ShoppingMission | null; // null when smalltalk/checkout or missing fields block creation
  draft: MissionDraft | null;      // normalized partial brief retained across onboarding turns
  missingFields: string[];         // e.g. ["budget"]
  reply?: string;                  // short conversational reply for smalltalk/clarification
};
export function parseMission(
  input: { text: string; imageUrl?: string },
  current: ShoppingMission | null,
  client: MissionModelClient,
  currentDraft?: MissionDraft | null,
): Promise<ParseResult>;
```

Server assigns stable ids (`crypto.randomUUID()`); model output re-validated
with `shoppingMissionSchema`; never invent budget/size/location; budget → integer cents.

## src/shopify/* (types.ts, auth.ts, mcp-client.ts, catalog.ts, cart.ts)

```ts
// catalog.ts
export function searchCatalog(args: { query: string; countryCode: string; imageUrl?: string }): Promise<ProductCandidate[]>; // ≤6 normalized
// cart.ts
export function createMerchantCarts(products: ProductCandidate[], countryCode: string): Promise<MerchantCart[]>;
```

Fixture behavior: when `SHOPIFY_FIXTURE_MODE=1` OR `SHOPIFY_CATALOG_CLIENT_ID`
is unset, both functions return data derived from `tests/fixtures/shopify.ts`
through the same code path as live normalization (fixtures are raw MCP-shaped
responses, not pre-normalized). Auth: POST client credentials to
`https://api.shopify.com/auth/access_token`, cache until 60s before JWT exp,
redact secrets in errors. MCP client: single `callMcpTool<T>(...)` with
10s timeout. Never log secrets or bearer tokens.

## src/web/server.ts + src/web/cards/{mission,checkout}.ts

```ts
export function createWebApp(deps: {
  getMission(missionId: string): ShoppingMission | null;
  getCheckoutPlan(missionId: string): CheckoutPlan | null;
  act(missionId: string, action: { kind: "lock" | "unlock" | "select"; slotId: string; variantId?: string }): ShoppingMission | null;
}): Hono; // routes: GET /healthz, GET /card/mission/:id, POST /card/mission/:id/action (form post, redirects back), GET /card/checkout/:id, GET /ucp/profile
export function startWebServer(deps: Parameters<typeof createWebApp>[0], port?: number): { port: number };
```

Cards are server-rendered HTML strings (no client framework), narrow-viewport
first, warm neutral canvas / near-black type / one accent. Mission card:
goal, constraints, `N / M items ready`, budget bar, per-slot rows (image, title,
price, seller, variant options, matched/uncertain constraints, Lock/Replace
controls posting to the action route), visible checkout blockers.
Checkout card: merchant groups, items, live subtotals, highlighted price
changes, one labeled `Open secure checkout` link per merchant.
`cards/*.ts` export `renderMissionCard(mission: ShoppingMission): string` and
`renderCheckoutCard(mission: ShoppingMission, plan: CheckoutPlan): string`.

## src/agent/loop.ts + src/agent/checkout.ts (integration — written last)

```ts
// checkout.ts
export function buildCheckoutPlan(mission: ShoppingMission, deps: { createMerchantCarts: typeof createMerchantCarts }): Promise<CheckoutPlan>;
// loop.ts
export function runAgentLoop(app: SpectrumApp, deps: {
  store: MissionStore; client: MissionModelClient;
  searchCatalog: typeof searchCatalog; createMerchantCarts: typeof createMerchantCarts;
  publicBaseUrl: string; // for app() card URLs
}): Promise<void>;
```

Loop rules: skip `direction === "outbound"`; record spaces to `.state/spaces.json`
(keep existing behavior in src/index.ts); wrap work in `space.responding(...)`;
on create → ack line + send `app(cardUrl, { live: true })` immediately in
searching state, search slots (concurrency 3), `edit()` the card as slots
resolve; on revise → only changed/unlocked slots; on checkout → blockers or
checkout card + one-line total summary noting price changes; on failed slot
search → keep partial results and say so in one line.
