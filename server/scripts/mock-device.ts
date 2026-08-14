/**
 * Mock bridge device — a fake phone for developing the server + pi side without
 * hardware. Connects over WS like the real app would, serves a fake Twitter
 * home/profile screen, and simulates commands (tapping "Profile" navigates to
 * the profile screen, BACK returns, panic disconnects).
 *
 * Usage: npm run mock   (from the server workspace, or `npm run mock` at root)
 * Env:  SOCIAL_PUPPET_WS (default ws://127.0.0.1:8743)
 *       SOCIAL_PUPPET_TOKEN
 *       SOCIAL_PUPPET_DEVICE_ID (default mock-phone-1)
 */
import WebSocket from "ws";
import { flattenTree, matchEntries } from "../src/flatten.js";
import { FindSpec, TreeNode } from "../src/types.js";

const WS_URL = process.env.SOCIAL_PUPPET_WS ?? "ws://127.0.0.1:8743";
/** Same server over HTTP — the mock stages screenshots/files here like the app does. */
const HTTP_URL = WS_URL.replace(/^ws/, "http").replace(/\/+$/, "");
const TOKEN = process.env.SOCIAL_PUPPET_TOKEN ?? "";
const DEVICE_ID = process.env.SOCIAL_PUPPET_DEVICE_ID ?? "mock-phone-1";
const NAME = process.env.SOCIAL_PUPPET_NAME ?? "Mock Pixel 8";

let ws: WebSocket | null = null;
let app = "com.twitter.android";
let screen: "home" | "profile" = "home";
let seq = 1;
let panic = false;
let attempt = 0;

const SCREEN: [number, number] = [1080, 2400];

function node(
  id: number,
  partial: Partial<TreeNode> & { bounds: TreeNode["bounds"] },
): TreeNode {
  return { id, visible: true, clickable: false, children: [], ...partial };
}

function homeTree(): TreeNode[] {
  const [w, h] = SCREEN;
  const tabW = w / 5;
  const tabY = h - 140;
  const nav: TreeNode[] = [];
  const tabs = [
    ["Home", "com.twitter.android:id/nav_home"],
    ["Search", "com.twitter.android:id/nav_search"],
    ["Spaces", "com.twitter.android:id/nav_spaces"],
    ["Notifications", "com.twitter.android:id/nav_notifications"],
    ["Profile", "com.twitter.android:id/nav_profile"],
  ];
  tabs.forEach(([label, rid], i) => {
    nav.push(
      node(100 + i, {
        text: label,
        resourceId: rid,
        className: "android.widget.FrameLayout",
        clickable: true,
        bounds: [i * tabW, tabY, (i + 1) * tabW, tabY + 140],
      }),
    );
  });
  return [
    node(1, { text: "X", className: "android.widget.TextView", bounds: [24, 60, 96, 132] }),
    node(2, {
      text: "For you",
      resourceId: "com.twitter.android:id/feed_top_tab",
      className: "android.widget.TextView",
      clickable: true,
      bounds: [24, 150, 200, 210],
    }),
    node(3, {
      text: "Good morning! The bridge is up. ☕",
      className: "android.widget.TextView",
      bounds: [24, 320, 1056, 430],
    }),
    node(4, {
      text: "Rust port of qwen3tts hitting RTF 0.31 on a chapter",
      className: "android.widget.TextView",
      bounds: [24, 500, 1056, 610],
    }),
    node(5, {
      text: "Feed item 3 — placeholder",
      className: "android.widget.TextView",
      bounds: [24, 680, 1056, 790],
    }),
    node(6, {
      text: "Feed item 4 — placeholder",
      className: "android.widget.TextView",
      bounds: [24, 860, 1056, 970],
    }),
    node(10, {
      text: "Bottom navigation",
      contentDesc: "Bottom navigation",
      className: "android.widget.LinearLayout",
      bounds: [0, tabY, w, tabY + 140],
      children: nav,
    }),
  ];
}

function profileTree(): TreeNode[] {
  const [w] = SCREEN;
  return [
    node(1, { text: "Jane Dev", className: "android.widget.TextView", bounds: [24, 100, 400, 170] }),
    node(2, { text: "@janedev", className: "android.widget.TextView", bounds: [24, 180, 300, 240] }),
    node(3, {
      text: "Building bridges between phones and agents. 🧵",
      className: "android.widget.TextView",
      bounds: [24, 260, 800, 330],
    }),
    node(4, {
      text: "Edit profile",
      resourceId: "com.twitter.android:id/edit_profile_button",
      className: "android.widget.Button",
      clickable: true,
      bounds: [w - 240, 90, w - 24, 170],
    }),
    node(5, { text: "1,234 Followers", className: "android.widget.TextView", bounds: [24, 360, 400, 420] }),
    node(6, { text: "567 Following", className: "android.widget.TextView", bounds: [24, 430, 400, 490] }),
    node(7, { text: "Posts", className: "android.widget.TextView", clickable: true, bounds: [24, 520, 220, 580] }),
    node(8, { text: "Replies", className: "android.widget.TextView", clickable: true, bounds: [230, 520, 430, 580] }),
    node(9, { text: "Highlights", className: "android.widget.TextView", clickable: true, bounds: [440, 520, 640, 580] }),
    node(10, {
      text: "This is the profile page — milestone 3 target.",
      className: "android.widget.TextView",
      bounds: [24, 620, 1056, 690],
    }),
  ];
}

function currentTree(): TreeNode[] {
  if (app === "com.twitter.android") {
    return screen === "home" ? homeTree() : profileTree();
  }
  return [
    node(1, { text: `${app}`, className: "android.widget.TextView", bounds: [24, 200, 800, 270] }),
    node(2, {
      text: "Mock app screen (nothing simulated here)",
      className: "android.widget.TextView",
      bounds: [24, 300, 900, 370],
    }),
  ];
}

function countNodes(nodes: TreeNode[]): number {
  let n = 0;
  for (const x of nodes) n += 1 + countNodes(x.children ?? []);
  return n;
}

function pushTree(): void {
  if (!ws) return;
  seq += 1;
  const nodes = currentTree();
  const count = countNodes(nodes);
  ws.send(
    JSON.stringify({
      type: "tree",
      seq,
      pkg: app,
      nodeCount: count,
      truncated: false,
      screen: { w: SCREEN[0], h: SCREEN[1], orientation: "portrait", density: 2.75 },
      windows: [{ id: 1, type: "active", active: true, pkg: app, nodes: count }],
      nodes,
    }),
  );
  ws.send(JSON.stringify({ type: "event", kind: "window", pkg: app, cls: screen }));
}

/** A 1x1 PNG — enough for the screenshot plumbing to be exercised end to end. */
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/** Stage bytes on the server exactly as the app's uploadToServer does. */
async function stage(name: string, mime: string, body: Buffer): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "content-type": mime,
    "x-file-name": encodeURIComponent(name),
    "x-file-mime": mime,
  };
  if (TOKEN) headers["authorization"] = `Bearer ${TOKEN}`;
  const res = await fetch(`${HTTP_URL}/api/v1/transfer`, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`stage failed: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}
function handleCommand(cmd: string, params: Record<string, unknown>): { ok: boolean; result?: unknown; error?: string } {
  switch (cmd) {
    case "launch": {
      const pkg = String(params.package ?? "");
      app = pkg;
      screen = "home";
      pushTree();
      return { ok: true, result: { launched: pkg } };
    }
    case "tap": {
      const find = (params.find ?? {}) as FindSpec;
      const hasFind = find.text !== undefined || find.resourceId !== undefined || find.contentDesc !== undefined;
      if (hasFind) {
        const entries = flattenTree(currentTree());
        const hit = matchEntries(entries, find);
        if (hit) {
          if (hit.text === "Profile" || hit.resourceId?.endsWith("nav_profile")) {
            screen = "profile";
            pushTree();
          } else if (hit.text === "Home" || hit.resourceId?.endsWith("nav_home")) {
            screen = "home";
            pushTree();
          } else if (hit.text === "Edit profile") {
            return { ok: true, result: { tapped: { text: hit.text }, simulated: "noop" } };
          }
          return { ok: true, result: { tapped: { id: hit.id, text: hit.text, resourceId: hit.resourceId } } };
        }
        return { ok: false, error: "not_found", result: { find } };
      }
      // Accept both pixel and normalized (0..1) coordinates, like the app does.
      const x = params.x !== undefined ? Number(params.x) : Number(params.xn) * SCREEN[0];
      const y = params.y !== undefined ? Number(params.y) : Number(params.yn) * SCREEN[1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, error: "tap needs x+y, xn+yn or a find-spec" };
      }
      return { ok: true, result: { tapped: { x, y }, simulated: "coords" } };
    }
    case "setText": {
      const mode = String(params.mode ?? "replace");
      const text = mode === "clear" ? "" : String(params.text ?? "");
      return {
        ok: true,
        result: {
          set: true,
          mode,
          text,
          steps: params.perChar ? text.length : 1,
          length: text.length,
          submitted: params.submit === true,
        },
      };
    }
    case "scrollTo": {
      const find = (params.find ?? {}) as FindSpec;
      const hit = matchEntries(flattenTree(currentTree()), find);
      if (hit) return { ok: true, result: { found: true, scrolls: 0, text: hit.text } };
      // The mock has no off-screen content, so a miss is a miss.
      return { ok: false, error: `not found after ${params.maxScrolls ?? 8} scroll(s)`, result: { found: false } };
    }
    case "swipe":
    case "scroll": {
      return { ok: true, result: { [cmd]: true } };
    }
    case "keyevent": {
      if (params.key === "back" && app === "com.twitter.android" && screen === "profile") {
        screen = "home";
        pushTree();
      }
      return { ok: true, result: { key: params.key } };
    }
    case "refresh": {
      pushTree();
      return { ok: true, result: { refreshed: seq } };
    }
    case "panic": {
      panic = true;
      setTimeout(() => ws?.close(), 50);
      return { ok: true, result: { panic: true } };
    }
    default:
      return { ok: false, error: `unknown command ${cmd}` };
  }
}

/** Commands whose result is produced asynchronously (they stage bytes first). */
async function handleAsyncCommand(
  cmd: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    if (cmd === "screenshot") {
      const meta = await stage(`screen-${Date.now()}.png`, "image/png", PIXEL_PNG);
      return { ok: true, result: { ...meta, w: 1, h: 1, mime: "image/png" } };
    }
    // getFile
    const name = String(params.name ?? "mock.txt");
    const meta = await stage(name, "text/plain", Buffer.from(`mock file ${name}\n`, "utf8"));
    return { ok: true, result: { ...meta, mime: "text/plain" } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function connect(): void {
  const url = TOKEN ? `${WS_URL}/?token=${encodeURIComponent(TOKEN)}` : WS_URL;
  ws = new WebSocket(url);
  ws.on("open", () => {
    attempt = 0;
    console.log(`[mock] connected to ${url}`);
    ws?.send(
      JSON.stringify({
        type: "hello",
        deviceId: DEVICE_ID,
        name: NAME,
        appVersion: "0.1.0-mock",
        screen: { w: SCREEN[0], h: SCREEN[1], orientation: "portrait", density: 2.75 },
        caps: {
          screenshot: true,
          imeEnter: true,
          dpadKeys: true,
          lockScreen: true,
          multiWindow: false,
          maxNodes: 1500,
          sdk: 35,
        },
      }),
    );
    ws?.send(JSON.stringify({ type: "status", battery: 91, charging: true }));
    pushTree();
  });
  ws.on("message", (data) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === "ping") {
      ws?.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (msg.type === "cmd") {
      const cmd = String(msg.cmd ?? "");
      const params = (msg.params ?? {}) as Record<string, unknown>;
      console.log(`[mock] cmd ${cmd} ${JSON.stringify(params)}`);
      if (cmd === "screenshot" || cmd === "getFile") {
        void handleAsyncCommand(cmd, params).then((res) =>
          ws?.send(JSON.stringify({ type: "result", cmdId: msg.cmdId, ...res })),
        );
        return;
      }
      const res = handleCommand(cmd, params);
      ws?.send(JSON.stringify({ type: "result", cmdId: msg.cmdId, ...res }));
      return;
    }
    console.log(`[mock] unknown message: ${String(data).slice(0, 120)}`);
  });
  ws.on("close", () => {
    console.log(`[mock] disconnected (panic=${panic})`);
    if (panic) return;
    attempt += 1;
    const delay = Math.min(2000 * 2 ** (attempt - 1), 15000);
    console.log(`[mock] reconnecting in ${delay}ms (attempt ${attempt})`);
    setTimeout(connect, delay);
  });
  ws.on("error", (e) => console.log(`[mock] ws error: ${e.message}`));
}

connect();

process.on("SIGINT", () => {
  console.log("\n[mock] bye");
  process.exit(0);
});
