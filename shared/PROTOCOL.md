# social-puppet protocol v1

The phone app connects **out** to the server over WebSocket. Controllers (pi, scripts) talk
to the server over HTTP. The server is the single source of truth: it holds the latest
accessibility tree per device, a ring buffer of a11y events, and a command queue.

```
pi / scripts ──HTTP──▶ server ◀──WebSocket── bridge app ──AccessibilityService──▶ phone UI
```

## Transport

| leg | protocol | base |
|---|---|---|
| app → server | WebSocket | `ws://<host>:8743/?token=…` |
| controller → server | HTTP | `http://<host>:8743/api/v1` |

Auth: if `SOCIAL_PUPPET_TOKEN` is set on the server, the WS connection must pass it as the
`token` query parameter and every HTTP request must send `Authorization: Bearer <token>`.
Without a token the server runs **open** (dev only) and logs a warning.

## Message framing

All messages are single-line JSON. The phone identifies itself in the `hello` message;
every later message is attributed to the WS connection it arrived on.

### app → server

```jsonc
{ "type": "hello", "deviceId": "pixel-8", "name": "Pixel 8", "appVersion": "0.1.0",
  "screen": { "w": 1080, "h": 2400, "orientation": "portrait", "density": 2.6 },
  "caps": { "screenshot": true, "imeEnter": true, "dpadKeys": true, "lockScreen": true,
            "multiWindow": true, "maxNodes": 1500, "sdk": 35 } }                     // what this device can do
{ "type": "tree", "seq": 7, "pkg": "com.twitter.android", "nodeCount": 412, "truncated": false,
  "screen": { … }, "windows": [ { "id": 12, "type": "active", "active": true, "pkg": "…", "nodes": 380 } ],
  "nodes": [ … ] }                                                                   // full tree push
{ "type": "event", "kind": "window" | "node", "pkg": "com.twitter.android", "text": "Profile", "cls": "…" }
{ "type": "status", "battery": 87, "charging": true }            // periodic (~60s) health
{ "type": "result", "cmdId": "…", "ok": true, "result": { … } }                      // reply to a cmd
{ "type": "pong" }
```

### server → app

```jsonc
{ "type": "cmd", "cmdId": "…", "cmd": "tap", "params": { … } }
{ "type": "ping" }
```

## Tree format

`nodes` is a recursive array. Every node:

```jsonc
{
  "id": 12,                      // int, unique within this tree
  "text": "Profile",             // node text, if any
  "contentDesc": "Profile tab",  // content description, if any
  "resourceId": "com.twitter.android:id/bottom_nav_profile",
  "className": "androidx.compose.ui.platform.ComposeView",
  "clickable": true,
  "visible": true,
  "bounds": [0, 2300, 300, 2400], // left, top, right, bottom (screen px)
  "window": { "id": 12, "type": "ime", "active": false, "pkg": "…" }, // ROOTS ONLY, see below
  "children": [ … ]
}
```

### Windows

A dump covers every interactive window, not just the focused one: the active app
first, then the IME, system dialogs, the notification shade, a split-screen partner.
Each window's root nodes carry a `window` tag (`active` | `application` | `ime` |
`system` | `a11yOverlay` | `splitDivider` | `other`), and the message-level `windows`
array summarises them. The server propagates a non-active window's type onto its
flattened entries as `win`, and renders it in the screen text as `[ime]`, `[system]`, …

`nodeCount` is how many nodes the dump contains; `truncated: true` means the app hit
its node budget (`caps.maxNodes`) and the tail of the screen is MISSING — a find-spec
that doesn't match may simply be past the cut.

The app **coalesces**: at most one dump per 300 ms, and a dump is only serialized and
sent when a content hash computed during the walk differs from the last one pushed.
`seq` is a timestamp and must therefore be stamped *after* the comparison — including
it in the hashed/compared content defeats the dedup entirely and turns every
content-changed event into a full tree push. Zero-size, invisible, and fully offscreen
subtrees are dropped at the source.

## Commands (server → app)

| cmd | params | notes |
|---|---|---|
| `launch` | `{ "package": "com.twitter.android" }` | open app via intent |
| `tap` | `{ "x": 540, "y": 2350 }`, `{ "xn": 0.5, "yn": 0.97 }` **or** `{ "find": {…} }` | px, normalized (0..1), or find-spec (resolved app-side against the *current* tree) |
| `setText` | `{ "find": {…}, "text": "hello", "mode": "replace\|append\|clear", "perChar": false, "charDelayMs": 30, "submit": false }` | set text on a focused/`find` node; see below |
| `swipe` | `{ "x1": 540, "y1": 1800, "x2": 540, "y2": 600, "duration": 400 }` | `x1n`/`y1n`/`x2n`/`y2n` accepted as normalized coords |
| `keyevent` | `{ "key": "back\|home\|recents\|enter\|notifications\|quickSettings\|lock\|dpadUp\|dpadDown\|dpadLeft\|dpadRight\|dpadCenter" }` | global actions only — an a11y service cannot inject arbitrary key codes. `enter` = the focused field's IME action |
| `scroll` | `{ "direction": "down", "distance": 800, "gesture": false }` | direction = how you move THROUGH the content (`down` = further down the feed). Uses the container's own scroll action, falling back to a gesture |
| `scrollTo` | `{ "find": {…}, "direction": "down", "maxScrolls": 8, "distance": 800, "settleMs": 450 }` | scroll until the find-spec resolves; returns `{ found, scrolls, text?, bounds? }` |
| `screenshot` | `{ "format": "webp\|jpeg\|png", "quality": 80, "maxDim": 1280 }` | real pixels. Staged on the server like any transfer; returns `{ fileId, url, name, mime, size, w, h }`. Android 11+; `FLAG_SECURE` windows cannot be captured |
| `refresh` | `{}` | re-dump the current tree now |
| `panic` | `{}` | HOME + lock screen (kill switch) |
| `putFile` | `{ "fileId", "name", "mime" }` | download a staged transfer into the app cache (off-main; long watchdog) |
| `getFile` | `{ "name" }` or `{ "path" }` | upload a file FROM the phone to the server's staging area; returns `{ fileId, url, … }`. Restricted to the bridge's own cache/files dirs |
| `shareFile` | `{ "name", "mime", "targetPackage"? }` | ACTION_SEND via FileProvider; `com.twitter.android` opens the X composer with media attached |

`refresh`, `screenshot` and `getFile` are read-only: the app runs them immediately
instead of queueing them behind an in-flight gesture, and the server lets them through
before the first tree has arrived.

### Typing

`ACTION_SET_TEXT` replaces a field's contents in one shot, which some apps' listeners
never see. `perChar: true` instead grows the value one character at a time, firing a
TextWatcher callback per step — that is what search-as-you-type and @mention
autocomplete react to. It is still not IME input (no key events are injected), so an
app that listens for keystrokes specifically will not be fooled. `submit: true` fires
the field's IME action (Search/Send/Go) afterwards.

### find-specs

Node ids are ephemeral across trees — never address by id. Address by content:

```jsonc
{ "text": "Profile" }                  // exact match (case-insensitive)
{ "text": "Profile", "contains": true }
{ "resourceId": "com.twitter.android:id/bottom_nav_profile" }
{ "contentDesc": "Profile tab" }
```

Resolution happens on the app at command time against its freshest tree, so layout
changes between dump and tap are harmless.

## HTTP API

All under `/api/v1`. Errors: `{ "error": { "code": "…", "message": "…" } }`.

| method | path | notes |
|---|---|---|
| GET | `/health` | `{ ok, devices }` |
| GET | `/devices` | list of device summaries |
| GET | `/devices/:id` | single device summary |
| GET | `/devices/:id/screen?limit=200&raw=1` | flattened screen text + entries; `raw=1` adds the full node tree. Also returns `treeTruncated` (device hit its node budget — distinct from `truncated`, which is this response's line limit), `nodeCount`, `windows`, `screen` |
| GET | `/devices/:id/events?since=0` | events with `seq > since`; returns `{ events, next }` |
| POST | `/devices/:id/refresh` | ask the app to re-dump |
| POST | `/devices/:id/command` | `{ "cmd", "params", "timeoutMs" }` → `{ ok, result }` or `{ ok: false, error }` |
| POST | `/devices/:id/wait` | `{ "match": {…}, "present": true, "timeoutMs" }` → `{ matched, entry?, screen }` |
| POST | `/devices/:id/panic` | kill switch |
| POST | `/api/v1/transfer` | upload a file (raw body + `X-File-Name`, `X-File-Mime` headers) → `{ fileId, name, mime, size, url }` |
| GET | `/transfer/:id` | download a staged file (token-gated; the phone pulls this over the same tunnel) |

Device status: `connected` = WS alive, `ready` = at least one tree received on this
connection. A reconnect invalidates the tree until a fresh one arrives.

Files staged for transfer live under the server's data dir with a 1h TTL. Bytes never
cross the WebSocket: pi uploads over HTTP, the app downloads over HTTP, and
`shareFile` hands the local file to the target app via an intent.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | bad/missing token |
| `not_found` | no such device |
| `device_disconnected` | WS gone — retry after reconnect |
| `device_not_ready` | connected but no tree yet |
| `queue_full` | >8 commands queued for one device |
| `timeout` / `timeout_queued` | no result within deadline |
| `bad_command` | unknown command |
| `not found after N scroll(s)` | `scrollTo` exhausted its budget (result carries `found: false`) |
