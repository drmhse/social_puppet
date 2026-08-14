/**
 * Self-test for the pi-extension client against a live server + mock device.
 * Run from the repo root:
 *   npm install
 *   npm run start  (terminal 1)
 *   npm run mock   (terminal 2)
 *   npx tsx pi-extension/self-test.ts
 */
import {
  fetchScreen,
  listDevices,
  refreshScreen,
  sendCommand,
  waitForMatch,
} from "./index.js";

const step = (name: string) => console.log(`\n== ${name} ==`);

async function main() {
  step("list devices");
  const devices = await listDevices();
  console.log(JSON.stringify(devices, null, 2));
  if (devices.length === 0) throw new Error("no devices — start server + mock first");

  step("screen (home)");
  let s = await fetchScreen(undefined, 60);
  console.log(s.text.split("\n").slice(0, 8).join("\n"));

  step("tap Profile by find-spec");
  console.log(await sendCommand(undefined, "tap", { find: { text: "Profile" } }));

  step("wait for @janedev");
  const w = await waitForMatch(undefined, { text: "@janedev" }, 10000);
  console.log(`matched=${w.matched}`);
  console.log((w.screen ?? "").split("\n").slice(0, 6).join("\n"));

  step("screen (profile)");
  s = await fetchScreen(undefined, 60);
  console.log(s.text.split("\n").slice(0, 6).join("\n"));

  step("key back");
  console.log(await sendCommand(undefined, "keyevent", { key: "back" }));

  step("wait for Home tab (contains)");
  const w2 = await waitForMatch(undefined, { text: "For you" }, 10000);
  console.log(`matched=${w2.matched}`);

  step("refresh");
  await refreshScreen(undefined);
  console.log("refreshed");

  step("tap missing element (should fail)");
  console.log(await sendCommand(undefined, "tap", { find: { text: "nonexistent-button" } }));

  step("launch twitter");
  console.log(await sendCommand(undefined, "launch", { package: "com.twitter.android" }));

  console.log("\n✅ self-test complete");
}

main().catch((e) => {
  console.error("❌ self-test failed:", e.message);
  process.exit(1);
});
