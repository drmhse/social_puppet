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
{ "type": "hello", "deviceId": "pixel-8", "name": "Pixel 8", "appVersion": "0.1.0", "screen": { "w": 1080, "h": 2400 } }
{ "type": "tree", "seq": 7, "pkg": "com.twitter.android", "nodes": [ … ] }          // full tree push
{ "type": "event", "kind": "window" | "node", "pkg": "com.twitter.android", "text": "Profile", "cls": "…" }
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
  "children": [ … ]
}
```

The app should **coalesce**: push at most one tree per ~400 ms, deduplicated by content
hash. Zero-size, offscreen, or invisible nodes should be dropped at the source.

## Commands (server → app)

| cmd | params | notes |
|---|---|---|
| `launch` | `{ "package": "com.twitter.android" }` | open app via intent |
| `tap` | `{ "x": 540, "y": 2350 }` **or** `{ "find": {…}, "index": 0 }` | coords or find-spec (resolved app-side against the *current* tree) |
| `setText` | `{ "find": {…}, "text": "hello" }` | set text on a focused/`find` node |
| `swipe` | `{ "x1": 540, "y1": 1800, "x2": 540, "y2": 600, "duration": 400 }` | |
| `keyevent` | `{ "key": "back" \| "home" \| "recents" \| "enter" }` | |
| `scroll` | `{ "direction": "down", "distance": 800 }` | |
| `refresh` | `{}` | re-dump the current tree now |
| `panic` | `{}` | HOME + lock screen (kill switch) |

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
| GET | `/devices/:id/screen?limit=200&raw=1` | flattened screen text + entries; `raw=1` adds the full node tree |
| GET | `/devices/:id/events?since=0` | events with `seq > since`; returns `{ events, next }` |
| POST | `/devices/:id/refresh` | ask the app to re-dump |
| POST | `/devices/:id/command` | `{ "cmd", "params", "timeoutMs" }` → `{ ok, result }` or `{ ok: false, error }` |
| POST | `/devices/:id/wait` | `{ "match": {…}, "present": true, "timeoutMs" }` → `{ matched, entry?, screen }` |
| POST | `/devices/:id/panic` | kill switch |

Device status: `connected` = WS alive, `ready` = at least one tree received on this
connection. A reconnect invalidates the tree until a fresh one arrives.

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
