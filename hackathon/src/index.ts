import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { runAgentLoop } from "./agent/loop";
import { createOpenAIMissionClient } from "./agent/mission-parser";
import { createMerchantCarts } from "./shopify/cart";
import { searchCatalog } from "./shopify/catalog";
import { MissionStore, type MissionAction } from "./state/mission-store";
import { startWebServer } from "./web/server";

// One process, two halves: the Hono card server and the Spectrum message
// loop, sharing a single in-memory MissionStore. Either half dying must take
// the whole process down loudly — a half-running agent is worse than a dead one.
function crash(context: string, error: unknown): never {
  console.error(`[fatal] ${context}:`, error);
  process.exit(1);
}
process.on("uncaughtException", (error) => crash("uncaught exception", error));
process.on("unhandledRejection", (reason) => crash("unhandled rejection", reason));

const store = new MissionStore();

function toMissionAction(action: {
  kind: "lock" | "unlock" | "select";
  slotId: string;
  variantId?: string;
}): MissionAction | null {
  switch (action.kind) {
    case "lock":
      return { type: "slotLocked", slotId: action.slotId };
    case "unlock":
      return { type: "slotUnlocked", slotId: action.slotId };
    case "select":
      return action.variantId
        ? { type: "candidateSelected", slotId: action.slotId, variantId: action.variantId }
        : null;
  }
}

const { port } = startWebServer({
  getMission: (missionId) => store.getByMissionId(missionId),
  getCheckoutPlan: (missionId) => store.getCheckoutPlan(missionId),
  act: (missionId, action) => {
    const spaceId = store.spaceIdForMission(missionId);
    if (!spaceId) return null;
    const missionAction = toMissionAction(action);
    // A select without a variant is a no-op re-render, not an error page.
    if (!missionAction) return store.getByMissionId(missionId);
    return store.dispatch(spaceId, missionAction);
  },
});

const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
console.log(`[web] card server on port ${port}; public base ${publicBaseUrl}`);

// Photon serves one live connection per project: any other process connecting
// (e.g. scripts/notify.ts) preempts this stream and ends the message iterator.
// Reconnect instead of dying so a stray connection or network blip can't take
// the agent down mid-demo. The mission store survives across reconnects.
const client = createOpenAIMissionClient();
const RECONNECT_DELAY_MS = 3_000;

for (;;) {
  try {
    const app = await Spectrum({
      projectId: process.env.PROJECT_ID!,
      projectSecret: process.env.PROJECT_SECRET!,
      providers: [imessage.config()],
    });
    console.log("[spectrum] connected — waiting for messages");
    await runAgentLoop(app, {
      store,
      client,
      searchCatalog,
      createMerchantCarts,
      publicBaseUrl,
    });
    console.warn("[spectrum] message stream ended (preempted or dropped) — reconnecting");
  } catch (error) {
    console.error("[spectrum] agent loop failed — reconnecting:", error);
  }
  await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
}
