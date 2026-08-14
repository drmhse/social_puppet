/**
 * Self-test for the pi-extension client against a live server + mock device.
 * Run from the repo root:
 *   npm install
 *   npm run start  (terminal 1)
 *   npm run mock   (terminal 2)
 *   npx tsx pi-extension/self-test.ts
 */
import {
  fetchFromDevice,
  fetchScreen,
  listDevices,
  refreshScreen,
  screenshot,
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

  step("screen metadata (windows / node budget)");
  const meta = await fetchScreen(undefined, 5);
  console.log({
    nodeCount: meta.nodeCount,
    treeTruncated: meta.treeTruncated,
    windows: meta.windows,
    screen: meta.screen,
  });

  step("type with mode/perChar/submit");
  console.log(
    await sendCommand(undefined, "setText", {
      text: "hello bridge",
      perChar: true,
      submit: false,
      mode: "replace",
    }),
  );

  step("scrollTo an on-screen item (should find at 0 scrolls)");
  console.log(await sendCommand(undefined, "scrollTo", { find: { text: "For you" }, maxScrolls: 3 }));

  step("scrollTo a missing item (should fail after scrolling)");
  console.log(await sendCommand(undefined, "scrollTo", { find: { text: "nope-not-here" }, maxScrolls: 2 }));

  step("normalized-coordinate tap");
  console.log(await sendCommand(undefined, "tap", { xn: 0.5, yn: 0.5 }));

  step("screenshot round-trip");
  const shot = await screenshot(undefined, { maxDim: 640 });
  console.log(`${shot.path} · ${shot.size} bytes · ${shot.w}x${shot.h}`);

  step("getFile round-trip");
  const pulled = await fetchFromDevice(undefined, "mock.txt");
  console.log(`${pulled.path} · ${pulled.size} bytes`);

  step("unknown command is rejected by the server");
  try {
    await sendCommand(undefined, "definitelyNotACommand", {});
    console.log("UNEXPECTED: server accepted an unknown command");
  } catch (e) {
    console.log(`rejected as expected: ${(e as Error).message}`);
  }

  console.log("\n✅ self-test complete");
}

main().catch((e) => {
  console.error("❌ self-test failed:", e.message);
  process.exit(1);
});
