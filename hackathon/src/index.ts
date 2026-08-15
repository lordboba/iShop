import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";

// Spectrum bridges a single agent loop to many messaging interfaces.
// Docs: https://photon.codes/docs/spectrum-ts
const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});

// Persist every inbound conversation so we can proactively message it later
// (Spectrum has no space-listing API; capture-on-inbound is the only path).
const STATE_DIR = new URL("../.state/", import.meta.url).pathname;
const SPACES_FILE = `${STATE_DIR}spaces.json`;
mkdirSync(STATE_DIR, { recursive: true });

function recordSpace(spaceId: string, senderId: string | undefined) {
  const known: Record<string, { senderId?: string; lastSeen: string }> =
    existsSync(SPACES_FILE) ? JSON.parse(readFileSync(SPACES_FILE, "utf8")) : {};
  known[spaceId] = { senderId, lastSeen: new Date().toISOString() };
  writeFileSync(SPACES_FILE, JSON.stringify(known, null, 2));
}

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  const spaceId = (space as unknown as { id?: string }).id ?? "unknown";
  recordSpace(spaceId, message.sender?.id);
  console.log(`[inbound] space=${spaceId} sender=${message.sender?.id ?? "?"} type=${message.content.type}`);
  if (message.content.type === "text") {
    await space.send(`echo: ${message.content.text}`);
  }
}
