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

function pushTree(): void {
  if (!ws) return;
  seq += 1;
  ws.send(JSON.stringify({ type: "tree", seq, pkg: app, nodes: currentTree() }));
  ws.send(JSON.stringify({ type: "event", kind: "window", pkg: app, cls: screen }));
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
      const x = Number(params.x);
      const y = Number(params.y);
      return { ok: true, result: { tapped: { x, y }, simulated: "coords" } };
    }
    case "setText": {
      return { ok: true, result: { set: true, text: String(params.text ?? "") } };
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
        screen: { w: SCREEN[0], h: SCREEN[1] },
      }),
    );
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
