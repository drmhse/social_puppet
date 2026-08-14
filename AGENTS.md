# social-puppet — agent instructions

Project: drive social apps on an Android phone via an accessibility bridge. pi →
HTTP → server → WebSocket → bridge app → a11y service → phone UI. Text-first (the a11y
tree), with a real `screenshot` command for the visual questions the tree can't answer.
Never adb input.

## Layout

- `server/` — Node + TS hub. Only runtime dep is `ws`. Run with `npm run start` (tsx).
  REST under `/api/v1`, WS at `/`, token via `SOCIAL_PUPPET_TOKEN`.
- `server/scripts/mock-device.ts` — fake phone; `npm run mock`. Simulates Twitter
  home/profile: tapping "Profile" navigates, BACK returns.
- `shared/PROTOCOL.md` — the contract. Read it before touching either side.
- `pi-extension/index.ts` — pi tools (`puppet_*`); client functions exported for
  `self-test.ts`.
- `android/` — bridge app (Kotlin). Build: `JAVA_HOME=<a JDK 17+> ./gradlew :app:assembleDebug`
  (the shell default here is JDK 11, which AGP rejects); install with `adb install -r`.
- `SCRATCHPAD.md` — decisions + issues; update it when you change course. Untracked:
  it accumulates deployment paths and device details that do not belong in a public repo.

## Working here

- `npm run start` + `npm run mock` + `npx tsx pi-extension/self-test.ts` is the loop.
  Keep it green.
- **Driving the phone:** load the `social-puppet-driving` skill (`.agents/skills/`, also
  symlinked to `~/.agents/skills/`) — it holds the X/Twitter playbook and the
  failure-mode interpretations learned on real hardware.
- Server code uses NodeNext module resolution: import local files with `.js` specifiers.
- `puppet_screen` output is the LLM's view of the phone — keep it readable and capped.
- Never address a11y nodes by id across trees; find-specs only (resolved app-side).
- The server is app-agnostic. Twitter-specific navigation belongs in the pi extension.
- The recurring trap here: a stale screen state looks live. `stale` flags, reconnect
  invalidates trees — preserve that invariant.
- **Tree pushes are deduped by a hash computed during the walk, before serializing.**
  `seq` is a timestamp: never fold it into the compared content, or every
  content-changed event becomes a full tree push. Same reason the dump is only
  serialized after the hash says something changed.
- Prefer the framework's indexed lookups (`findAccessibilityNodeInfosByViewId` /
  `ByText`) over walking nodes by hand: a manual DFS is one binder round-trip per node.
- App config changes must be pushed into the running service
  (`BridgeService.applyConfigChange()`); the socket URL is captured once per
  connection and every reconnect reuses it.
