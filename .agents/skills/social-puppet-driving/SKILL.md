---
name: social-puppet-driving
description: Drive an Android phone through the social-puppet bridge using the puppet_* tools (puppet_screen, puppet_screenshot, puppet_tap, puppet_type, puppet_swipe, puppet_scroll, puppet_scroll_to, puppet_key, puppet_wait, puppet_launch, puppet_refresh, puppet_send_file, puppet_get_file, puppet_share, puppet_panic, puppet_devices). The phone is controlled by a bridge app over the accessibility tree — text-first, with a real screenshot available when the answer is visual; never adb input. Use when the user asks to operate, inspect, or automate apps on a connected phone (e.g. posting or browsing on X/Twitter). Includes the X/Twitter navigation playbook and failure-mode interpretation.
---

# Driving a phone with social-puppet

Architecture: pi → `puppet_*` tools → server (:8743) → WebSocket → bridge app → accessibility service → phone UI.
The screen you read is the **live accessibility tree** (text + bounds), not pixels — with `puppet_screenshot` as the escape hatch when the question is visual. The phone is only ever driven by the bridge app — never use `adb shell input` for control.

## Toolkit

| tool | use |
|---|---|
| `puppet_devices` | what's connected and ready; run first. Reports `caps` (screenshot support, node budget) |
| `puppet_screen` | read the current screen as text; `limit` caps lines |
| `puppet_screenshot` | real pixels → a local file. For anything the tree can't say |
| `puppet_launch` | open an app by package name (e.g. `com.twitter.android`) |
| `puppet_tap` | tap by find-spec (`text` / `contentDesc` / `resourceId`, optional `contains`), by `x,y`, or by `xn,yn` (0..1) |
| `puppet_type` | type text; `into` find-spec, `mode` replace/append/clear, `perChar`, `submit` |
| `puppet_scroll` | scroll one step; `direction` = how you move through the content |
| `puppet_scroll_to` | scroll until a find-spec appears — one call instead of a swipe/dump loop |
| `puppet_swipe` | arbitrary gesture between two points (px or normalized) |
| `puppet_key` | back / home / recents / enter / notifications / quickSettings / lock / dpad* |
| `puppet_wait` | block until a find-spec matches — **never use fixed sleeps** |
| `puppet_refresh` | force a fresh tree dump when the view seems stale |
| `puppet_send_file` / `puppet_get_file` | push a local file to the phone / pull one back |
| `puppet_share` | hand a file on the phone to an app (e.g. the X composer) |
| `puppet_panic` | kill switch: HOME + lock |

## Golden rules (learned the hard way)

1. **Read before you act.** `puppet_screen` is the source of truth — you cannot see the phone otherwise. Between every action, verify with `puppet_screen` or `puppet_wait`.
2. **Prefer find-specs over coordinates.** `puppet_tap` by `text`/`contentDesc` resolves against the live tree at tap time and survives layout changes. Use coordinates only for buttons with no text/desc (e.g. floating action buttons).
3. **Node ids in the dump are per-snapshot — never reuse them.** Match by content, not by id.
4. **A tiny dump means an overlay.** If `puppet_screen` returns few nodes, a sheet/dialog is covering the app and the app's own window exposes only the overlay (e.g. a post-options bottom sheet, a menu, the nav drawer). Dismiss it or interact with it — don't assume the app vanished. (System dialogs and the shade now appear as separate `[system]`-tagged entries, so check the `windows` summary before concluding the app is gone.)
5. **A `puppet_wait` TIMEOUT is often the success signal.** Waiting for text to *disappear* ("Sending post…", a post you just deleted) times out on the contains-match — that means the text is gone. Treat timeouts as "condition not met", then inspect the screen dump it returns.
6. **STALE flag on `puppet_screen` → `puppet_refresh`** before trusting the dump. The bridge only pushes trees on change; a screen that didn't change for a while is flagged stale.
7. **Commands right after `puppet_launch` / reconnect can time out once** (sent during the app's reconnect window). Retry once.
8. **Icon-only buttons expose `contentDesc`** (Verified, Like, Repost, Post options, Show navigation drawer…). Text often lives in separate nodes from the clickable container — find-spec taps on text nodes fall back to a gesture at the node center (result `"method":"gesture"` — that's normal, not an error).
9. **`resourceId` is usually null in Compose apps** — rely on text/contentDesc.
10. **To reach off-screen content, use `puppet_scroll_to`**, not a swipe/dump loop — it scrolls and re-checks on the phone, so one call replaces N round-trips. `puppet_scroll` moves one step; `direction` names how you move THROUGH the content (`down` = further down the feed). *(This is the opposite of what the old `scroll` command did — it used to name the finger direction.)*
11. **The dump covers every window, not just the app.** Entries from the keyboard, a system dialog or the notification shade are tagged `[ime]` / `[system]` in the screen text. A composer screen that suddenly shows 40 extra "keys" is the IME, not the app.
12. **`DEVICE NODE BUDGET HIT` in the `puppet_screen` header means the screen is incomplete** — the app stopped at its node cap (1500). A find-spec that doesn't match may just be past the cut; scroll or narrow the screen before concluding something isn't there.
13. **`puppet_type` replaces the whole field by default.** If the app must react as you type — search suggestions, `@`-mention autocomplete — pass `perChar: true`. Use `submit: true` for the keyboard's Search/Send/Go rather than hunting for a button.
14. **Reach for `puppet_screenshot` when the tree can't answer**: unlabeled images, video, charts, "is the right photo attached", or a layout question. It costs one round-trip and ~30 KiB as webp. Banking apps and DRM video (`FLAG_SECURE`) cannot be captured by anyone — a failure there is not a bug.

## Failure interpretation

| you see | meaning | do |
|---|---|---|
| `no node matched find-spec` | text not on screen (scrolled / overlay / wrong app) | re-dump; scroll; check overlay |
| `timeout` | command lost (reconnect) or app busy | retry once |
| tap ok but nothing happened | coords hit non-interactive area | re-dump, switch to find-spec |
| `ACTION_SET_TEXT failed` | field is read-only, a password, or not focused | tap the field first; passwords can't be filled this way |
| `not found after N scroll(s)` | `puppet_scroll_to` exhausted its budget | raise `maxScrolls`, check direction, or the item really isn't there |
| `screenshot failed: … FLAG_SECURE …` | the app blocks capture (banking, DRM) | fall back to `puppet_screen`; no workaround exists |
| `screenshot needs Android 11` | device too old | check `caps.screenshot` in `puppet_devices` |
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
