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

  app.get("/ucp/profile", (c) => {
    const base = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
    return c.json({
      name: "mission-shopper",
      description: "Mission-based shopping agent: brief in, complete purchasable kit out.",
      urls: {
        base,
        profile: `${base}/ucp/profile`,
        missionCard: `${base}/card/mission/{missionId}`,
        checkoutCard: `${base}/card/checkout/{missionId}`,
      },
      capabilities: [
        { name: "mission_card", kind: "web_view", url: `${base}/card/mission/{missionId}` },
        { name: "mission_action", kind: "http_form", url: `${base}/card/mission/{missionId}/action` },
        { name: "checkout_card", kind: "web_view", url: `${base}/card/checkout/{missionId}` },
      ],
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
