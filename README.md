# social-puppet

**Drive an Android phone from an agent or a script, through the accessibility tree.**

Every Android app publishes a live, structured description of its screen so screen
readers can speak it. social-puppet reads that description, hands it to whatever is
driving as plain text, and performs the taps, typing and gestures that come back. No
vision model, no cabled `adb` session, no app that had to agree to be automated.

```
controller ──HTTP──▶ server ◀──WebSocket── bridge app ──AccessibilityService──▶ phone UI
```

The phone dials out, so it works from behind NAT with no inbound address and survives
moving between Wi-Fi and cellular. `adb` installs the app and, in development, opens a
network tunnel; it never drives the device.

## Try it in two minutes, no phone required

Needs Node 20 or newer.

```sh
npm install
npm run start                        # server on :8743
npm run mock                         # a simulated phone, in another terminal
npx tsx pi-extension/self-test.ts    # drives it end to end
```

The self-test lists devices, reads a screen as text, taps by content, waits for the
result, scrolls to something off-screen, moves a file each way and takes a screenshot.
It is the fastest way to see the shape of the API before wiring up hardware.

## Add a real phone

Needs a JDK 17 or newer, and Android 8 or newer on the phone (Android 11 for
screenshots). Tested on a Pixel 9.

```sh
cd android
JAVA_HOME=<jdk-17-or-newer> ./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8743 tcp:8743        # or point the app at your machine's LAN IP
```

In the app: **Setup**, enter the server URL and token, **Save**. Then **Accessibility
settings** and turn the bridge on. Android 13 and later hide that toggle for sideloaded
apps until you allow "Restricted setting" from the app's info page.

## What driving it looks like

Anything that speaks HTTP can drive a phone:

```sh
export T=your-token ID=your-device-id
curl -sH "authorization: Bearer $T" localhost:8743/api/v1/devices

curl -sH "authorization: Bearer $T" \
  "localhost:8743/api/v1/devices/$ID/screen?limit=40"

curl -sH "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"cmd":"tap","params":{"find":{"contentDesc":"Post"}}}' \
  localhost:8743/api/v1/devices/$ID/command
```

A screen comes back as one line per visible node, tagged with the window it belongs to:

```
15 | What's happening? @(147,453) 431x59
24 | Post [btn] @(872,209) 176x95
79 | yt [btn] [ime] @(115,1459) 272x127
```

| command | what it does |
|---|---|
| `launch` | open an app by package name |
| `tap` | by find-spec, by pixel coordinates, or by normalized `xn`/`yn` |
| `setText` | replace, append or clear; `perChar` fires the app's text watchers, `submit` presses the IME action |
| `swipe`, `scroll` | gestures; `scroll` uses the container's own scroll action where there is one |
| `scrollTo` | scroll until a find-spec resolves, looping on the device rather than per round trip |
| `keyevent` | back, home, recents, enter, notifications, quickSettings, lock, d-pad |
| `screenshot` | real pixels, downscaled and staged over HTTP |
| `putFile`, `getFile`, `shareFile` | move files either way, hand one to another app |
| `refresh`, `panic` | re-dump now; home and lock as a kill switch |

Parameters, the tree format and the full wire contract are in
[shared/PROTOCOL.md](shared/PROTOCOL.md).

For agents, `pi-extension/` registers these as `puppet_*` tools. Symlink it into
`~/.pi/agent/extensions/` and `/reload`. It reads `SOCIAL_PUPPET_SERVER` (default
`http://127.0.0.1:8743`) and `SOCIAL_PUPPET_TOKEN`.

## How it works

![Sequence diagram of one session: the phone opens the WebSocket and sends hello, then
streams its screen only when a content hash differs from the last push; a tap arrives
as a command and is resolved against the live tree at that moment; a screenshot is
staged over HTTP so the socket carries only a file identifier.](docs/architecture.png)

**Elements are addressed by what they are, not where they were.** A find-spec over text,
content description or resource id is resolved against the live tree at the moment of
the tap, so it survives the screen changing between reading and acting, and fails
loudly when the target genuinely is not there.

**A screen is only sent when it changes.** The bridge hashes each node as it walks and
serializes nothing when that hash matches the last push, so a static screen produces one
message every twenty seconds rather than the several per second that answering every
content-change event would cost.

**Loops that need no decisions run on the device.** `scrollTo` scrolls and re-checks on
the phone instead of spending a round trip, a screen read and a model turn per swipe.

**File bytes never cross the WebSocket.** Uploads and screenshots are staged on the
server over HTTP with a one hour TTL, and the socket carries an identifier.

There is a longer write-up in
[Driving a Phone Through Its Accessibility Tree](https://www.drmhse.com/posts/driving-a-phone-through-its-accessibility-tree/).

## Limits with no workaround

- `FLAG_SECURE` windows, meaning banking apps and DRM video, cannot be screenshotted by
  anything on the device.
- An accessibility service cannot dismiss the lock screen, so a reboot needs a human.
- Android exposes global actions rather than arbitrary key codes; the `keyevent` list
  above is the entire keyboard.
- Apps that hide content from the accessibility layer are invisible to this, in exactly
  the way they are invisible to a screen reader.

## Security and privacy

**One operator, one shared secret.** `SOCIAL_PUPPET_TOKEN` gates both the WebSocket and
the REST API, and without it the server runs open and says so at startup. Any holder of
that token can drive any connected phone: there is no per-device authorisation, no user
model, no rate limiting. The phone's token travels in the WebSocket query string, where
a reverse proxy will log it. Put the server behind TLS, treat the token as a password
for the phone itself, and keep it off networks you do not control.

**The bridge app can read everything on screen and type into anything.** That is the
same capability a screen reader has, and the same one Android malware abuses. It is
sideload-only, since automating through an accessibility service is against Play policy.

**The session log records commands and results.** Screen trees are logged as counts
rather than content and typed text is redacted to its length, but tapped labels and
command parameters land in `data/session-*.jsonl` in plaintext. `SOCIAL_PUPPET_LOG=0`
turns it off.

## Project layout

| path | what |
|---|---|
| `server/` | Node and TypeScript hub: REST for controllers, WS for phones, per-device state, event ring, command queue, file staging. One runtime dependency (`ws`) |
| `android/` | the bridge app: `BridgeService` (tree dump, commands), `TreeDumper`, `ServerConnection`, setup UI |
| `pi-extension/` | the `puppet_*` tools, and a client library the self-test uses |
| `shared/PROTOCOL.md` | the wire contract, versioned with the code |
| `docs/` | diagram sources; render with `java -jar plantuml.jar -tsvg -o . docs/*.puml` |
| `.agents/skills/` | the driving playbook: what actually breaks on real apps, and how to read the failures |

## Status and contributing

Working, and used daily against one phone. The protocol is versioned but not frozen, so
expect commands to gain parameters. `npm run start` plus `npm run mock` plus
`npx tsx pi-extension/self-test.ts` is the development loop, and the mock implements
every command, so most work needs no hardware. Protocol changes belong in
`shared/PROTOCOL.md` in the same commit as the code, and a new command needs a mock
implementation and a self-test line. Reports of apps whose accessibility trees behave
unusually are especially welcome, since that is the part no amount of local testing
covers.

## Responsible use

Automating an account is against the terms of service of most platforms, whatever the
input method. This exists to operate your own phone. Do not use it to run accounts at
scale, and do not point it at a device that is not yours.

## License

[Apache License 2.0](LICENSE).
