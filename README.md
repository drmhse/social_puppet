# social-puppet

Drive social apps on an Android phone through an accessibility bridge. **pi** talks
HTTP to a **server**; the server relays commands over WebSocket to a **bridge app** on
the phone; the bridge app reads the live accessibility tree (no screenshots) and
performs taps/types/swipes.

```
pi / scripts ──HTTP──▶ server ◀──WebSocket── bridge app ──AccessibilityService──▶ phone UI
```

The phone is only ever driven by the bridge app — no `adb shell input`, no debug-mode
piping. ADB is at most a dev-only network tunnel.

## Layout

| path | what |
|---|---|
| `server/` | Node + TS hub: REST for controllers, WS for phones, per-device state, event ring, command queue, JSONL session log |
| `shared/PROTOCOL.md` | the wire contract (WS + HTTP + tree format + commands) |
| `pi-extension/` | pi extension registering `puppet_*` tools; app-agnostic flows live here |
| `android/` | the bridge app: `BridgeService` (a11y dump + commands), `ServerConnection` (WS out), `SetupActivity`/`MainActivity` |
| `SCRATCHPAD.md` | working notes, decisions, issues |

## Quickstart (milestone 1 — no phone needed)

```sh
npm install
npm run start            # terminal 1: server on :8743
npm run mock             # terminal 2: fake phone (simulated Twitter home/profile)
npx tsx pi-extension/self-test.ts   # terminal 3: end-to-end control plane check
```

Expected: devices listed → screen read as text → tap "Profile" by find-spec →
`wait for @janedev` matches → BACK returns home → missing-element tap fails cleanly.

### Wire pi to it

```sh
ln -s /Users/mc/Desktop/projects/AI/social-puppet/pi-extension ~/.pi/agent/extensions/social-puppet
```

then `/reload` in pi. Tools: `puppet_devices`, `puppet_screen`, `puppet_launch`,
`puppet_tap`, `puppet_type`, `puppet_swipe`, `puppet_key`, `puppet_wait`,
`puppet_refresh`, `puppet_panic`.

Env for the extension: `SOCIAL_PUPPET_SERVER` (default `http://127.0.0.1:8743`),
`SOCIAL_PUPPET_TOKEN`.

## Security

Set `SOCIAL_PUPPET_TOKEN` on the server for anything beyond local dev — without it the
server is open and anyone on the network can drive connected phones. The bridge app is
a powerful accessibility tool by design: read everything on screen, type into anything.
Treat it accordingly.

## Status

- [x] Milestone 1 — protocol, server, mock device, pi extension (working)
- [x] Milestone 2 — Android bridge app (a11y dump, gestures, WS client, setup)
- [x] Milestone 3 — **real device: Twitter → profile page, driven through the app** (Pixel 9)
- [ ] Milestone 4 — hardening (token everywhere, jitter, panic, screenshot fallback)

## Testing on a real phone

1. **Start the server with a token** (phone and Mac on the same network):
   ```sh
   SOCIAL_PUPPET_TOKEN=changeme npm run start
   # find your Mac's LAN IP:
   ipconfig getifaddr en0
   ```
2. **Install the app + tunnel** (adb is used only for install and the network
   tunnel — never to control):
   ```sh
   cd android
   JAVA_HOME=/Applications/Android\ Studio.app/Contents/jbr/Contents/Home \
     ./gradlew :app:assembleDebug
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   adb reverse tcp:8743 tcp:8743
   ```
3. **Configure**: open the app → Setup → server URL `ws://127.0.0.1:8743` (with the
   reverse tunnel) or `ws://<mac-ip>:8743` (LAN), token, name → Save.
   Tap **Extend screen timeout to 30 min** and grant the write-settings prompt.
4. **Enable the bridge**: Accessibility settings → social-puppet bridge → ON.
5. **Drive it**: in pi (`/reload` if needed) → `puppet_devices` should list the phone;
   then `puppet_screen`, `puppet_launch` (package `com.twitter.android`), `puppet_tap`,
   `puppet_wait`…

**Verified on Pixel 9 / Android 17 (Aug 2026):** launcher read as text; Twitter
launched and its profile page opened via the drawer; `puppet_devices`/`puppet_screen`/
`puppet_wait` worked from a real pi session. Play Protect rated the sideloaded app
NOT_HARMFUL. Known rough edges: commands sent during the app's reconnect window can
time out (retry); `enter` key ≈ click on focused field.

See `SCRATCHPAD.md` for decisions (D1–D11) and the issue log (I1–I15).
