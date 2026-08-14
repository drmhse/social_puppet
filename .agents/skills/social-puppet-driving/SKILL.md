---
name: social-puppet-driving
description: Drive an Android phone through the social-puppet bridge using the puppet_* tools (puppet_screen, puppet_tap, puppet_type, puppet_swipe, puppet_key, puppet_wait, puppet_launch, puppet_refresh, puppet_panic, puppet_devices). The phone is controlled by a bridge app over the accessibility tree — no screenshots, no adb input. Use when the user asks to operate, inspect, or automate apps on a connected phone (e.g. posting or browsing on X/Twitter). Includes the X/Twitter navigation playbook and failure-mode interpretation.
---

# Driving a phone with social-puppet

Architecture: pi → `puppet_*` tools → server (:8743) → WebSocket → bridge app → accessibility service → phone UI.
The screen you read is the **live accessibility tree** (text + bounds), not pixels. The phone is only ever driven by the bridge app — never use `adb shell input` for control.

## Toolkit

| tool | use |
|---|---|
| `puppet_devices` | what's connected and ready; run first |
| `puppet_screen` | read the current screen as text; `limit` caps lines |
| `puppet_launch` | open an app by package name (e.g. `com.twitter.android`) |
| `puppet_tap` | tap by find-spec (`text` / `contentDesc` / `resourceId`, optional `contains`) OR by `x,y` |
| `puppet_type` | type text; `into` find-spec for the field |
| `puppet_swipe` | scroll/swipe between two points |
| `puppet_key` | system keys: back / home / recents / enter |
| `puppet_wait` | block until a find-spec matches — **never use fixed sleeps** |
| `puppet_refresh` | force a fresh tree dump when the view seems stale |
| `puppet_panic` | kill switch: HOME + lock |

## Golden rules (learned the hard way)

1. **Read before you act.** `puppet_screen` is the source of truth — you cannot see the phone otherwise. Between every action, verify with `puppet_screen` or `puppet_wait`.
2. **Prefer find-specs over coordinates.** `puppet_tap` by `text`/`contentDesc` resolves against the live tree at tap time and survives layout changes. Use coordinates only for buttons with no text/desc (e.g. floating action buttons).
3. **Node ids in the dump are per-snapshot — never reuse them.** Match by content, not by id.
4. **A tiny dump means an overlay.** If `puppet_screen` returns few nodes, a sheet/dialog is covering the app and the tree exposes only the overlay (e.g. a post-options bottom sheet, a menu, the nav drawer). Dismiss it or interact with it — don't assume the app vanished.
5. **A `puppet_wait` TIMEOUT is often the success signal.** Waiting for text to *disappear* ("Sending post…", a post you just deleted) times out on the contains-match — that means the text is gone. Treat timeouts as "condition not met", then inspect the screen dump it returns.
6. **STALE flag on `puppet_screen` → `puppet_refresh`** before trusting the dump. The bridge only pushes trees on change; a screen that didn't change for a while is flagged stale.
7. **Commands right after `puppet_launch` / reconnect can time out once** (sent during the app's reconnect window). Retry once.
8. **Icon-only buttons expose `contentDesc`** (Verified, Like, Repost, Post options, Show navigation drawer…). Text often lives in separate nodes from the clickable container — find-spec taps on text nodes fall back to a gesture at the node center (result `"method":"gesture"` — that's normal, not an error).
9. **`resourceId` is usually null in Compose apps** — rely on text/contentDesc.
10. **Scroll = `puppet_swipe` from lower to upper** (finger up). If the target item isn't in the dump, it's off-screen: scroll, then re-dump.

## Failure interpretation

| you see | meaning | do |
|---|---|---|
| `no node matched find-spec` | text not on screen (scrolled / overlay / wrong app) | re-dump; scroll; check overlay |
| `timeout` | command lost (reconnect) or app busy | retry once |
| tap ok but nothing happened | coords hit non-interactive area | re-dump, switch to find-spec |
| tiny dump | overlay/sheet covering the app | `puppet_key` back or find its Close/dismiss |
| 401 on all tools | server requires a token the session doesn't have | restart server with/without token matching the session env |

## Setup check (if tools error)

- Server up: `npm run start` in `social-puppet/` (root). Mock phone: `npm run mock`. Self-test: `npx tsx pi-extension/self-test.ts`.
- USB dev tunnel: `adb reverse tcp:8743 tcp:8743` (control still goes through the app — adb is only a network path).
- Token: server `SOCIAL_PUPPET_TOKEN` must match the session's env / app config.
- Screen awake: the app extends the timeout to 30 min; if the dump goes dead the screen likely slept — wake it.
- After installing/updating the bridge app, wait a few seconds for reconnect before commanding.

## X/Twitter playbook

See [references/x-twitter.md](references/x-twitter.md) for the current app map (package `com.twitter.android`).

**Posting**: floating "+" (bottom-right) → composer → `puppet_type` → Post (top-right).
**Profile**: top-left avatar (`contentDesc "Show navigation drawer"`) → drawer → "Profile". There is NO Profile tab in the bottom nav.
**Deleting**: profile → Posts tab → find the post → its "Post options" (…) → "Delete post" → confirm "Delete".
**Finding your own posts**: go to the PROFILE — the home feed is algorithmic and re-ranks; never hunt for your content there.

## Caution (X-side risk)

X's bot detection is behavioral and backend-side: pacing, cadence, bulk actions. Keep delays varied, avoid machine-regular intervals, cap bulk operations (follows/likes/DMs), and don't run identical action sequences back-to-back. The bridge is invisible at the input layer — the risk is pattern, not method.
