// One-shot proactive notification into a previously recorded conversation.
// Usage: bun scripts/notify.ts "<message>"
import { readFileSync } from "node:fs";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const message = process.argv[2];
if (!message) {
  console.error("usage: bun scripts/notify.ts \"<message>\"");
  process.exit(1);
}

const spaces: Record<string, { senderId?: string; lastSeen: string }> = JSON.parse(
  readFileSync(new URL("../.state/spaces.json", import.meta.url), "utf8"),
);
const latest = Object.entries(spaces).sort(
  (a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen),
)[0];
if (!latest) {
  console.error("no recorded spaces in .state/spaces.json");
  process.exit(1);
}
const [spaceId, { senderId }] = latest;

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});

const im = imessage(app);
try {
  // Prefer the exact recorded conversation; fall back to a DM by sender handle.
  const space = await im.space.get(spaceId).catch(async () => {
    if (!senderId) throw new Error("space lookup failed and no senderId recorded");
    return im.space.create(await im.user(senderId));
  });
  await space.send(message);
  console.log(`sent to ${spaceId}`);
} finally {
  await app.stop();
}
