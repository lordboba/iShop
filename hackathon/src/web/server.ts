import { Hono } from "hono";
import type { CheckoutPlan, ShoppingMission } from "../domain/mission";
import { renderCheckoutCard } from "./cards/checkout";
import { renderMissionCard } from "./cards/mission";

export type WebDeps = {
  getMission(missionId: string): ShoppingMission | null;
  getCheckoutPlan(missionId: string): CheckoutPlan | null;
  act(
    missionId: string,
    action: { kind: "lock" | "unlock" | "select"; slotId: string; variantId?: string },
  ): ShoppingMission | null;
};

const ACTION_KINDS = new Set(["lock", "unlock", "select"]);

export function createWebApp(deps: WebDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/card/mission/:id", (c) => {
    const mission = deps.getMission(c.req.param("id"));
    if (!mission) return c.text("Mission not found", 404);
    return c.html(renderMissionCard(mission));
  });

  app.post("/card/mission/:id/action", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const kind = body.kind;
    const slotId = body.slotId;
    if (typeof kind !== "string" || !ACTION_KINDS.has(kind) || typeof slotId !== "string") {
      return c.text("Bad request", 400);
    }
    const variantId = typeof body.variantId === "string" && body.variantId ? body.variantId : undefined;
    const mission = deps.act(id, {
      kind: kind as "lock" | "unlock" | "select",
      slotId,
      variantId,
    });
    if (!mission) return c.text("Mission not found", 404);
    // 303 so the webview re-GETs the card after the form post.
    return c.redirect(`/card/mission/${encodeURIComponent(id)}`, 303);
  });

  app.get("/card/checkout/:id", (c) => {
    const id = c.req.param("id");
    const mission = deps.getMission(id);
    const plan = deps.getCheckoutPlan(id);
    if (!mission || !plan) return c.text("Checkout plan not found", 404);
    return c.html(renderCheckoutCard(mission, plan));
  });

  // UCP-conformant agent profile (schema per Shopify's published example at
  // shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json).
  // Shopify's catalog rejects hand-rolled shapes with 422 invalid_profile_url,
  // and rejects responses without a cacheable Cache-Control ("profile_malformed:
  // Invalid cache control") — so the header below is load-bearing.
  app.get("/ucp/profile", (c) => {
    c.header("cache-control", "public, max-age=3600, stale-while-revalidate=7200");
    return c.json({
      ucp: {
        version: "2026-04-08",
        services: {
          "dev.ucp.shopping": [
            {
              version: "2026-04-08",
              spec: "https://ucp.dev/2026-04-08/specification/overview",
              transport: "mcp",
              schema: "https://ucp.dev/2026-04-08/services/shopping/mcp.openrpc.json",
            },
          ],
        },
        capabilities: {
          "dev.ucp.shopping.checkout": [{ version: "2026-04-08" }],
          "dev.ucp.shopping.cart": [
            {
              version: "2026-04-08",
              spec: "https://ucp.dev/2026-04-08/specification/cart",
              schema: "https://ucp.dev/2026-04-08/schemas/shopping/cart.json",
            },
          ],
          "dev.ucp.shopping.catalog.search": [
            {
              version: "2026-04-08",
              spec: "https://ucp.dev/2026-04-08/specification/catalog/search",
              schema: "https://ucp.dev/2026-04-08/schemas/shopping/catalog_search.json",
            },
          ],
          "dev.ucp.shopping.catalog.lookup": [
            {
              version: "2026-04-08",
              spec: "https://ucp.dev/2026-04-08/specification/catalog/lookup",
              schema: "https://ucp.dev/2026-04-08/schemas/shopping/catalog_lookup.json",
            },
          ],
          "dev.shopify.catalog.global": [
            {
              version: "2026-04-08",
              spec: "https://shopify.dev/docs/agents/catalog/global-catalog",
              schema: "https://shopify.dev/ucp/schemas/2026-04-08/shopify_catalog_global.json",
              extends: ["dev.ucp.shopping.catalog.lookup", "dev.ucp.shopping.catalog.search"],
            },
          ],
        },
        payment_handlers: {},
      },
    });
  });

  return app;
}

export function startWebServer(
  deps: WebDeps,
  port = Number(process.env.PORT ?? 3000),
): { port: number } {
  const server = Bun.serve({ fetch: createWebApp(deps).fetch, port });
  return { port: server.port ?? port };
}
