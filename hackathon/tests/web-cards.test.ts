import { describe, expect, it } from "bun:test";
import type {
  CheckoutPlan,
  ProductCandidate,
  ShoppingMission,
} from "../src/domain/mission";
import { renderCheckoutCard } from "../src/web/cards/checkout";
import { escapeHtml, renderMissionCard } from "../src/web/cards/mission";
import { createWebApp, type WebDeps } from "../src/web/server";

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    productId: "p1",
    variantId: "v1",
    title: "Bomber Jacket",
    imageUrl: "https://cdn.example.com/jacket.jpg",
    sellerName: "Northwind Outfitters",
    sellerDomain: "northwind.example.com",
    price: 8900,
    currency: "USD",
    selectedOptions: { Size: "M", Color: "Black" },
    buyUrl: "https://northwind.example.com/buy/v1",
    matchedConstraints: ["no leather"],
    uncertainConstraints: ["water resistant"],
    ...overrides,
  };
}

function mission(overrides: Partial<ShoppingMission> = {}): ShoppingMission {
  return {
    id: "m1",
    goal: "Rooftop party outfit",
    countryCode: "US",
    budget: { amount: 25000, currency: "USD" },
    globalHardConstraints: ["no leather"],
    globalPreferences: ["dark colors"],
    slots: [
      {
        id: "s1",
        label: "Jacket",
        query: "black bomber jacket",
        required: true,
        hardConstraints: ["no leather"],
        softPreferences: [],
        candidates: [
          candidate(),
          candidate({ variantId: "v2", title: "Field Jacket", price: 12000 }),
        ],
        selectedVariantId: "v1",
        locked: true,
      },
      {
        id: "s2",
        label: "Shoes",
        query: "white sneakers 9.5",
        required: true,
        hardConstraints: [],
        softPreferences: [],
        candidates: [],
        locked: false,
      },
    ],
    status: "searching",
    ...overrides,
  };
}

function plan(overrides: Partial<CheckoutPlan> = {}): CheckoutPlan {
  return {
    merchants: [
      {
        name: "Northwind Outfitters",
        domain: "northwind.example.com",
        items: [{ variantId: "v1", title: "Bomber Jacket", quantity: 1, livePrice: 9100 }],
        subtotal: 9100,
        continueUrl: "https://northwind.example.com/checkout/abc",
        mode: "cart",
      },
      {
        name: "Sole Supply",
        domain: "solesupply.example.com",
        items: [
          {
            variantId: "v9",
            title: "Court Sneaker 9.5",
            quantity: 1,
            livePrice: 7500,
            buyUrl: "https://solesupply.example.com/buy/v9",
          },
        ],
        subtotal: 7500,
        continueUrl: "https://solesupply.example.com",
        mode: "handoff",
      },
    ],
    previousTotal: 16400,
    liveTotal: 16600,
    priceChanges: [{ variantId: "v1", before: 8900, after: 9100 }],
    ...overrides,
  };
}

function makeDeps(m: ShoppingMission | null = mission()): WebDeps & {
  calls: Array<{ missionId: string; action: Parameters<WebDeps["act"]>[1] }>;
} {
  const calls: Array<{ missionId: string; action: Parameters<WebDeps["act"]>[1] }> = [];
  return {
    calls,
    getMission: (id) => (m && id === m.id ? m : null),
    getCheckoutPlan: (id) => (m && id === m.id ? plan() : null),
    act(missionId, action) {
      calls.push({ missionId, action });
      return m && missionId === m.id ? m : null;
    },
  };
}

describe("renderMissionCard", () => {
  it("shows goal, readiness count, formatted prices, and blockers", () => {
    const html = renderMissionCard(mission());
    expect(html).toContain("Rooftop party outfit");
    expect(html).toContain("1 / 2 items ready");
    expect(html).toContain("$89.00"); // 8900 cents
    expect(html).toContain("$250.00"); // budget cap
    expect(html).toContain("Northwind Outfitters");
    expect(html).toContain("Size: M");
    expect(html).toContain("Missing required item: Shoes");
  });

  it("flags over-budget totals as a blocker", () => {
    const m = mission({ budget: { amount: 5000, currency: "USD" } });
    const html = renderMissionCard(m);
    expect(html).toContain("Over budget by $39.00");
  });

  it("renders Lock for unlocked selections and Unlock for locked ones", () => {
    const locked = renderMissionCard(mission());
    expect(locked).toContain(">Unlock<");
    const m = mission();
    m.slots[0]!.locked = false;
    const unlocked = renderMissionCard(m);
    expect(unlocked).toContain(">Lock<");
    expect(unlocked).toContain("Replace"); // alternatives available when unlocked
    expect(unlocked).toContain('value="v2"');
  });

  it("renders Unlock for a locked slot even when nothing is selected", () => {
    // A stale lock without a selection must stay recoverable from the card.
    const m = mission();
    m.slots[0]!.selectedVariantId = undefined;
    const html = renderMissionCard(m);
    expect(html).toContain(">Unlock<");
  });

  it("escapes interpolated strings", () => {
    const m = mission({ goal: '<script>alert("x")</script>' });
    const html = renderMissionCard(m);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("escapeHtml", () => {
  it("escapes all five special characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("renderCheckoutCard", () => {
  it("shows merchant groups, subtotals, price changes, and checkout links", () => {
    const html = renderCheckoutCard(mission(), plan());
    expect(html).toContain("Northwind Outfitters");
    expect(html).toContain("Sole Supply");
    expect(html).toContain("$91.00"); // live subtotal
    expect(html).toContain("$75.00");
    expect(html).toContain("$166.00"); // live total
    expect(html).toContain("was $164.00"); // previous total when prices changed
    expect(html).toContain("$89.00"); // struck-through before price
    expect(html).toContain("Prices changed");
    expect(html).toContain('href="https://northwind.example.com/checkout/abc"');
    // "Open secure checkout" is reserved for revalidated cart-mode merchants
    expect((html.match(/Open secure checkout/g) ?? []).length).toBe(1);
  });

  it("renders handoff merchants with per-item buy links, never as live-verified", () => {
    const html = renderCheckoutCard(mission(), plan());
    expect(html).toContain('href="https://solesupply.example.com/buy/v9"');
    expect(html).toContain("Buy Court Sneaker 9.5");
    expect(html).toContain("confirm on the merchant site");
    expect(html).not.toContain("Live total"); // handoff prices were never re-checked
  });

  it("offers a combined add-all link for a multi-item handoff merchant", () => {
    const p = plan({
      merchants: [
        {
          name: "Sole Supply",
          domain: "solesupply.example.com",
          items: [
            { variantId: "v9", title: "Court Sneaker 9.5", quantity: 1, livePrice: 7500, buyUrl: "https://solesupply.example.com/cart/900:1" },
            { variantId: "v10", title: "Crew Socks", quantity: 1, livePrice: 1200, buyUrl: "https://solesupply.example.com/cart/910:1" },
          ],
          subtotal: 8700,
          continueUrl: "https://solesupply.example.com/cart/900:1,910:1",
          mode: "handoff",
        },
      ],
      priceChanges: [],
      liveTotal: 8700,
      previousTotal: 8700,
    });
    const html = renderCheckoutCard(mission(), p);
    expect(html).toContain("Add all 2 items to cart");
    expect(html).toContain('href="https://solesupply.example.com/cart/900:1,910:1"');
    // per-item links remain as secondary fallbacks
    expect(html).toContain('href="https://solesupply.example.com/cart/900:1"');
    expect(html).not.toContain("Each link buys one item");
  });

  it("falls back to a labeled storefront link when a handoff item has no buy url", () => {
    const p = plan();
    p.merchants[1]!.items[0]!.buyUrl = undefined;
    const html = renderCheckoutCard(mission(), p);
    expect(html).toContain('href="https://solesupply.example.com"');
    expect(html).toContain("Find Court Sneaker 9.5 on solesupply.example.com");
  });

  it("labels the total as live only when every merchant was revalidated", () => {
    const p = plan();
    p.merchants = p.merchants.filter((m) => m.mode === "cart");
    const html = renderCheckoutCard(mission(), p);
    expect(html).toContain("Live total");
  });

  it("omits the price-change notice when nothing changed", () => {
    const html = renderCheckoutCard(mission(), plan({ priceChanges: [], liveTotal: 16400 }));
    expect(html).not.toContain("Prices changed");
  });
});

describe("createWebApp routes", () => {
  it("GET /healthz returns ok", async () => {
    const res = await createWebApp(makeDeps()).request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /card/mission/:id renders the card and 404s when missing", async () => {
    const app = createWebApp(makeDeps());
    const ok = await app.request("/card/mission/m1");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Rooftop party outfit");
    const missing = await app.request("/card/mission/nope");
    expect(missing.status).toBe(404);
  });

  it("POST action calls deps.act and redirects back to the card", async () => {
    const deps = makeDeps();
    const app = createWebApp(deps);
    const body = new URLSearchParams({ kind: "lock", slotId: "s1" });
    const res = await app.request("/card/mission/m1/action", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/card/mission/m1");
    expect(deps.calls).toEqual([
      { missionId: "m1", action: { kind: "lock", slotId: "s1", variantId: undefined } },
    ]);
  });

  it("POST select forwards variantId", async () => {
    const deps = makeDeps();
    const app = createWebApp(deps);
    const body = new URLSearchParams({ kind: "select", slotId: "s1", variantId: "v2" });
    const res = await app.request("/card/mission/m1/action", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(303);
    expect(deps.calls[0]!.action).toEqual({ kind: "select", slotId: "s1", variantId: "v2" });
  });

  it("POST action rejects bad kinds and unknown missions", async () => {
    const deps = makeDeps();
    const app = createWebApp(deps);
    const bad = await app.request("/card/mission/m1/action", {
      method: "POST",
      body: new URLSearchParams({ kind: "explode", slotId: "s1" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(bad.status).toBe(400);
    expect(deps.calls.length).toBe(0);
    const missing = await app.request("/card/mission/nope/action", {
      method: "POST",
      body: new URLSearchParams({ kind: "lock", slotId: "s1" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(missing.status).toBe(404);
  });

  it("GET /card/checkout/:id renders merchant checkout links", async () => {
    const app = createWebApp(makeDeps());
    const res = await app.request("/card/checkout/m1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Open secure checkout");
    expect(html).toContain("$166.00");
    const missing = await app.request("/card/checkout/nope");
    expect(missing.status).toBe(404);
  });

  it("GET /ucp/profile serves a UCP-conformant agent profile", async () => {
    const res = await createWebApp(makeDeps()).request("/ucp/profile");
    expect(res.status).toBe(200);
    const profile = (await res.json()) as {
      ucp: {
        version: string;
        services: Record<string, unknown>;
        capabilities: Record<string, Array<{ version: string; extends?: string[] }>>;
        payment_handlers: Record<string, unknown>;
      };
    };
    expect(profile.ucp.version).toBe("2026-04-08");
    expect(profile.ucp.services["dev.ucp.shopping"]).toBeDefined();
    for (const capability of [
      "dev.ucp.shopping.checkout",
      "dev.ucp.shopping.cart",
      "dev.ucp.shopping.catalog.search",
      "dev.ucp.shopping.catalog.lookup",
      "dev.shopify.catalog.global",
    ]) {
      expect(profile.ucp.capabilities[capability]).toBeDefined();
    }
    expect(profile.ucp.capabilities["dev.shopify.catalog.global"]![0]!.extends).toEqual([
      "dev.ucp.shopping.catalog.lookup",
      "dev.ucp.shopping.catalog.search",
    ]);
    expect(profile.ucp.payment_handlers).toEqual({});
  });
});
