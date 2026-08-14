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
moving between Wi-Fi and cellular. `adb` installs the app and, in development, provides
a network tunnel; it never drives the device.

![Sequence diagram: the phone opens the WebSocket, streams its screen only when a
content hash changes, and resolves a tap against the live tree at the moment it
runs; screenshot bytes are staged over HTTP rather than sent on the
socket.](docs/architecture.png)

The diagram is generated from [docs/architecture.puml](docs/architecture.puml):
`java -jar plantuml.jar -tpng -o . docs/architecture.puml`.

There is a longer write-up of the design in
[Driving a Phone Through Its Accessibility Tree](https://www.drmhse.com/posts/driving-a-phone-through-its-accessibility-tree/).

## Try it in two minutes, no phone required

```sh
npm install
npm run start                        # server on :8743
npm run mock                         # a simulated phone, in another terminal
npx tsx pi-extension/self-test.ts    # drives it end to end
```

The self-test lists devices, reads a screen as text, taps by content, waits for the
result, moves a file each way and takes a screenshot. It is also the fastest way to see
the shape of the API before wiring up hardware.

## Add a real phone

```sh
cd android
JAVA_HOME=<a JDK 17 or newer> ./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8743 tcp:8743        # or point the app at your machine's LAN IP
```

In the app: **Setup**, enter the server URL and token, **Save**. Then **Accessibility
settings** and turn the bridge on. Android 13 and later hide that toggle for sideloaded
apps until you allow "Restricted setting" from the app's info page.

Tested on a Pixel 9. Needs Android 8 or newer; screenshots need Android 11.

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

A screen comes back as one line per visible node, with the window each belongs to:

```
15 | What's happening? @(147,453) 431x59
24 | Post [btn] @(872,209) 176x95
79 | yt [btn] [ime] @(115,1459) 272x127
```

Elements are addressed by **what they are**, not where they were. A find-spec over
text, content description or resource id is resolved against the live tree at the
moment of the tap, so it survives the layout changing between reading and acting, and
fails loudly when the target genuinely is not there.

## Commands

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

Full wire contract, tree format and parameters: [shared/PROTOCOL.md](shared/PROTOCOL.md).

For agents, `pi-extension/` registers these as `puppet_*` tools. Symlink it into
`~/.pi/agent/extensions/` and `/reload`. It reads `SOCIAL_PUPPET_SERVER` (default
`http://127.0.0.1:8743`) and `SOCIAL_PUPPET_TOKEN`.

## Limits with no workaround

- `FLAG_SECURE` windows, meaning banking apps and DRM video, cannot be screenshotted by
  anything on the device.
- An accessibility service cannot dismiss the lock screen, so a reboot needs a human.
- Android exposes global actions rather than arbitrary key codes; the list above is the
  entire keyboard.
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

## Repository

| path | what |
|---|---|
| `server/` | Node and TypeScript hub: REST for controllers, WS for phones, per-device state, event ring, command queue, file staging. One runtime dependency (`ws`) |
| `android/` | the bridge app: `BridgeService` (tree dump, commands), `TreeDumper`, `ServerConnection`, setup UI |
| `pi-extension/` | the `puppet_*` tools, and a client library the self-test uses |
| `shared/PROTOCOL.md` | the wire contract, versioned with the code |
| `.agents/skills/` | the driving playbook: what actually breaks on real apps, and how to read the failures |

## Contributing

`npm run start` + `npm run mock` + `npx tsx pi-extension/self-test.ts` is the loop; keep
it green. The mock phone implements every command, so most work needs no hardware.
Protocol changes belong in `shared/PROTOCOL.md` in the same commit as the code, and any
new command needs a mock implementation and a self-test line. Issues and pull requests
are welcome, particularly reports of apps whose trees behave unusually.

## Responsible use

Automating an account is against the terms of service of most platforms, whatever the
input method. This exists to operate your own phone. Do not use it to run accounts at
scale, and do not point it at anyone else's device.

## License

[Apache License 2.0](LICENSE).
