# social-puppet

Drive an Android phone from an agent or a script, through the accessibility tree.

A bridge app on the phone reads the live accessibility tree, sends it as text, and
performs taps, typing and gestures. A server relays between it and whatever is driving.
The phone dials out, so it needs no inbound address; nothing ever connects to it.

```
controller ──HTTP──▶ server ◀──WebSocket── bridge app ──AccessibilityService──▶ phone UI
```

Control is only ever the app. `adb` installs it and, in development, provides a network
tunnel; it never drives the device.

## What it can do

Read the screen as text, including the keyboard and system windows. Tap, type, swipe
and scroll, addressing elements by their text, content description or resource id
rather than coordinates. Scroll until something appears. Take a real screenshot for the
questions text cannot answer. Move files both ways and hand one to another app.

Three limits have no workaround: `FLAG_SECURE` windows (banking, DRM video) cannot be
captured, an accessibility service cannot dismiss the lock screen, and Android exposes
global actions rather than arbitrary key codes.

## Quickstart, no phone needed

```sh
npm install
npm run start                        # server on :8743
npm run mock                         # a fake phone, in another terminal
npx tsx pi-extension/self-test.ts    # end-to-end check
```

## With a phone

```sh
cd android
JAVA_HOME=<a JDK 17+> ./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8743 tcp:8743        # or point the app at your machine's LAN IP
```

In the app: Setup, enter the server URL and token, Save. Then Accessibility settings
and turn the bridge on. Android 13 and later hide that toggle for sideloaded apps until
"Restricted setting" is allowed from the app's info page.

Verified on a Pixel 9. Requires Android 8 or later, Android 11 for screenshots.

## Driving it

The controller is a pi extension registering `puppet_*` tools: `puppet_devices`,
`puppet_screen`, `puppet_screenshot`, `puppet_launch`, `puppet_tap`, `puppet_type`,
`puppet_swipe`, `puppet_scroll`, `puppet_scroll_to`, `puppet_key`, `puppet_wait`,
`puppet_refresh`, `puppet_send_file`, `puppet_get_file`, `puppet_share`,
`puppet_panic`. Symlink `pi-extension/` into `~/.pi/agent/extensions/` and `/reload`.
It reads `SOCIAL_PUPPET_SERVER` (default `http://127.0.0.1:8743`) and
`SOCIAL_PUPPET_TOKEN`.

Anything else speaks HTTP to the same server. The wire contract, the tree format and
every command are in [shared/PROTOCOL.md](shared/PROTOCOL.md).

## Trust model

One operator, one shared secret. `SOCIAL_PUPPET_TOKEN` gates both the WebSocket and the
REST API, and without it the server runs open and says so at startup. Any holder of
that token can drive any connected phone: there is no per-device authorisation, no user
model, and no rate limiting. The phone's token travels in the WebSocket query string,
where a reverse proxy will record it in its access log. Put the server behind TLS,
treat the token as a password for the phone itself, and do not expose it to a network
you do not control.

The bridge app can read everything on screen and type into anything, which is the same
capability a screen reader has and the same one Android malware abuses. It is
sideloadable only, since automation through an accessibility service is against Play
policy.

**The session log records commands and their results.** Screen trees are logged as
counts rather than content, and typed text is redacted to its length, but tapped labels
and command parameters are written to `data/session-*.jsonl` in plaintext. Set
`SOCIAL_PUPPET_LOG=0` to turn it off.

## Layout

| path | what |
|---|---|
| `server/` | Node and TypeScript hub: REST for controllers, WS for phones, per-device state, event ring, command queue, transfer staging |
| `android/` | the bridge app: `BridgeService` (tree dump, commands), `TreeDumper`, `ServerConnection`, setup UI |
| `pi-extension/` | the `puppet_*` tools and a client library |
| `shared/PROTOCOL.md` | the wire contract |
| `.agents/skills/` | the driving playbook, including what breaks on real apps |

## Use of it

Automating an account is against the terms of service of most platforms, whatever the
input method. This is built to operate one person's own phone. Do not use it to run
accounts at scale.
