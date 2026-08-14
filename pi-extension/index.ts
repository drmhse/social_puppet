/**
 * social-puppet pi extension.
 *
 * Registers puppet_* tools that drive phones through the social-puppet server
 * (see ../shared/PROTOCOL.md). The phone is controlled by the bridge app over
 * WebSocket; this extension only talks HTTP to the server.
 *
 * Env:
 *   SOCIAL_PUPPET_SERVER  (default http://127.0.0.1:8743)
 *   SOCIAL_PUPPET_TOKEN
 *
 * Install: symlink this directory into ~/.pi/agent/extensions/ (or add its
 * index.ts to settings.json "extensions"), then /reload in pi.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const SERVER = (process.env.SOCIAL_PUPPET_SERVER ?? "http://127.0.0.1:8743").replace(/\/+$/, "");

/**
 * Token resolution: env var first (documented setup), then the deployed server's
 * local env file so pi runs embedded in the bridge without a bridge restart.
 */
function resolveToken(): string {
  if (process.env.SOCIAL_PUPPET_TOKEN) return process.env.SOCIAL_PUPPET_TOKEN;
  try {
    const txt = readFileSync("/etc/social-puppet.env", "utf8");
    const m = txt.match(/^SOCIAL_PUPPET_TOKEN\s*=\s*(.+)$/m);
    return m?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}
const TOKEN = resolveToken();

// ---------------------------------------------------------------------------
// REST client (exported so the self-test can exercise it without a pi session)
// ---------------------------------------------------------------------------

export async function api<T = unknown>(path: string, init?: { json?: unknown; timeoutMs?: number }): Promise<T> {
  const p = path.startsWith("/api/") ? path : `/api/v1${path}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (TOKEN) headers["authorization"] = `Bearer ${TOKEN}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`${SERVER}${p}`, {
      method: init?.json !== undefined ? "POST" : "GET",
      headers,
      body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const err = (data as { error?: { message?: string } })?.error?.message;
      throw new Error(`${res.status} ${err ?? "request failed"}`);
    }
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface DeviceSummary {
  id: string;
  name?: string;
  connected: boolean;
  ready: boolean;
  pkg?: string;
  entries: number;
  battery?: number;
  charging?: boolean;
}

export async function listDevices(): Promise<DeviceSummary[]> {
  return api<DeviceSummary[]>("/devices");
}

export async function pickDevice(device?: string): Promise<{ id: string; name?: string }> {
  if (device) return { id: device };
  const list = await listDevices();
  const ready = list.find((d) => d.connected);
  if (!ready) {
    throw new Error(
      "no connected device — start the bridge app (or mock device) and check `puppet_devices`",
    );
  }
  return { id: ready.id, name: ready.name };
}

export interface ScreenResult {
  pkg?: string;
  seq?: number;
  at?: number;
  stale?: boolean;
  entries: unknown[];
  text: string;
  truncated?: boolean;
}

export async function fetchScreen(device?: string, limit = 200): Promise<ScreenResult> {
  const d = await pickDevice(device);
  return api<ScreenResult>(`/devices/${encodeURIComponent(d.id)}/screen?limit=${limit}`);
}

export interface CommandResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

export async function sendCommand(
  device: string | undefined,
  cmd: string,
  params: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<CommandResult> {
  const d = await pickDevice(device);
  return api<CommandResult>(`/devices/${encodeURIComponent(d.id)}/command`, {
    json: { cmd, params, timeoutMs },
    timeoutMs: timeoutMs + 5000,
  });
}

export async function waitForMatch(
  device: string | undefined,
  match: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<{ matched: boolean; entry?: unknown; screen?: string }> {
  const d = await pickDevice(device);
  return api(`/devices/${encodeURIComponent(d.id)}/wait`, {
    json: { match, timeoutMs },
    timeoutMs: timeoutMs + 5000,
  });
}

export async function refreshScreen(device?: string): Promise<void> {
  const d = await pickDevice(device);
  await api(`/devices/${encodeURIComponent(d.id)}/refresh`, { json: {} });
}

// ---------------------------------------------------------------------------
// File transfer (images/videos) — staged on the server, downloaded by the app
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".3gp": "video/3gpp",
};

export function mimeFor(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? MIME[path.slice(dot).toLowerCase()] : undefined;
}

export interface UploadResult {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  phonePath: string;
}

/** Upload a local file to the server, then command the phone to download it. */
export async function uploadToDevice(
  device: string | undefined,
  filePath: string,
): Promise<UploadResult> {
  const buf = readFileSync(filePath);
  const name = basename(filePath);
  const mime = mimeFor(filePath) ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": mime,
    "x-file-name": encodeURIComponent(name),
    "x-file-mime": mime,
    "x-file-size": String(buf.length),
  };
  if (TOKEN) headers["authorization"] = `Bearer ${TOKEN}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  let res: Response;
  try {
    res = await fetch(`${SERVER}/api/v1/transfer`, {
      method: "POST",
      headers,
      body: buf,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${data?.error?.message ?? "upload failed"}`);
  }
  const t = data as { fileId: string; name: string; mime: string; size: number };
  const put = await sendCommand(device, "putFile", { fileId: t.fileId, name: t.name, mime: t.mime }, 300_000);
  if (!put.ok) throw new Error(`putFile failed: ${put.error}`);
  return {
    fileId: t.fileId,
    name: t.name,
    mime: t.mime,
    size: t.size,
    phonePath: String((put.result as { path?: string } | undefined)?.path ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

function ok(text: string, details: object = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function describe(result: CommandResult): string {
  if (result.ok) {
    const r = result.result ?? {};
    return `ok${Object.keys(r).length ? ` · ${JSON.stringify(r)}` : ""}`;
  }
  return `FAILED: ${result.error ?? "unknown error"}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "puppet_devices",
    label: "Puppet Devices",
    description: "List phones connected to the social-puppet bridge and their readiness.",
    promptSnippet: "List connected phones and their status",
    promptGuidelines: [
      "Use puppet_devices to see which phones are connected to the social-puppet server before driving them.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const list = await listDevices();
      if (list.length === 0) {
        return ok("No devices connected. Start the bridge app (or `npm run mock`) and retry.");
      }
      const text = list
        .map(
          (d) =>
            `• ${d.name ?? d.id} (${d.id}) — ${d.connected ? (d.ready ? "ready" : "connecting…") : "disconnected"}` +
            `${d.pkg ? ` · showing ${d.pkg}` : ""}${d.entries ? ` · ${d.entries} nodes` : ""}` +
            `${d.battery !== undefined ? ` · battery ${d.battery}%${d.charging ? " (charging)" : ""}` : ""}`,
        )
        .join("\n");
      return ok(text, { devices: list });
    },
  });

  pi.registerTool({
    name: "puppet_screen",
    label: "Puppet Screen",
    description:
      "Read what is currently on the phone screen as text (from the accessibility tree, no screenshot). Optional `device` id, default first connected. `limit` caps lines shown.",
    promptSnippet: "Read the phone screen as text",
    promptGuidelines: [
      "Use puppet_screen to see what is on the phone before deciding what to tap or type.",
    ],
    parameters: Type.Object({
      device: Type.Optional(Type.String({ description: "device id (default: first connected)" })),
      limit: Type.Optional(Type.Number({ description: "max screen lines to return", default: 200 })),
    }),
    async execute(_id, params) {
      const s = await fetchScreen(params.device, params.limit ?? 200);
      const head = `${s.pkg ?? "?"} · seq ${s.seq ?? "?"} · ${s.entries.length} nodes${s.stale ? " (STALE)" : ""}${s.truncated ? " (truncated)" : ""}`;
      return ok(`${head}\n\n${s.text}`, { pkg: s.pkg, entries: s.entries });
    },
  });

  pi.registerTool({
    name: "puppet_launch",
    label: "Puppet Launch",
    description: "Open an app on the phone by package name, e.g. com.twitter.android.",
    promptSnippet: "Open an app on the phone by package name",
    promptGuidelines: ["Use puppet_launch to open an app (package name) on the phone."],
    parameters: Type.Object({
      package: Type.String({ description: "android package name, e.g. com.twitter.android" }),
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const r = await sendCommand(params.device, "launch", { package: params.package });
      return ok(`launch ${params.package}: ${describe(r)}`, r);
    },
  });

  const findProps = {
    text: Type.Optional(Type.String({ description: "match node text (exact, case-insensitive)" })),
    contains: Type.Optional(Type.Boolean({ description: "text match is a substring test" })),
    resourceId: Type.Optional(Type.String({ description: "match node resource-id" })),
    contentDesc: Type.Optional(Type.String({ description: "match node content description" })),
  } as const;

  pi.registerTool({
    name: "puppet_tap",
    label: "Puppet Tap",
    description:
      "Tap on the phone. Give coordinates (x,y) OR a find-spec (text / resourceId / contentDesc) resolved against the live accessibility tree. Prefer find-specs — they survive layout changes.",
    promptSnippet: "Tap a point or a UI element on the phone",
    promptGuidelines: [
      "Use puppet_tap with a text/resourceId/contentDesc find-spec to tap UI elements; coordinates are the fallback.",
    ],
    parameters: Type.Object({
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      text: Type.Optional(Type.String()),
      contains: Type.Optional(Type.Boolean()),
      resourceId: Type.Optional(Type.String()),
      contentDesc: Type.Optional(Type.String()),
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const { device, x, y, ...rest } = params;
      const params2: Record<string, unknown> = {};
      if (x !== undefined && y !== undefined) {
        params2.x = x;
        params2.y = y;
      } else {
        const find: Record<string, unknown> = {};
        if (rest.text !== undefined) find.text = rest.text;
        if (rest.contains !== undefined) find.contains = rest.contains;
        if (rest.resourceId !== undefined) find.resourceId = rest.resourceId;
        if (rest.contentDesc !== undefined) find.contentDesc = rest.contentDesc;
        if (Object.keys(find).length === 0) {
          return ok("puppet_tap needs x+y or at least one find field", {});
        }
        params2.find = find;
      }
      const r = await sendCommand(device, "tap", params2);
      return ok(`tap ${JSON.stringify(params2)}: ${describe(r)}`, r);
    },
  });

  pi.registerTool({
    name: "puppet_type",
    label: "Puppet Type",
    description:
      "Type text on the phone. If `into` (find-spec) is given, set the text into that field; otherwise the focused field is used.",
    promptSnippet: "Type text into the phone",
    promptGuidelines: ["Use puppet_type to enter text into the phone, with an optional `into` find-spec."],
    parameters: Type.Object({
      text: Type.String({ description: "text to type" }),
      into: Type.Optional(
        Type.Object({
          text: Type.Optional(Type.String()),
          contains: Type.Optional(Type.Boolean()),
          resourceId: Type.Optional(Type.String()),
          contentDesc: Type.Optional(Type.String()),
        }),
      ),
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const r = await sendCommand(params.device, "setText", {
        text: params.text,
        ...(params.into ? { find: params.into } : {}),
      });
      return ok(`type "${params.text}": ${describe(r)}`, r);
    },
  });

  pi.registerTool({
    name: "puppet_swipe",
    label: "Puppet Swipe",
    description: "Swipe between two screen points on the phone.",
    promptSnippet: "Swipe on the phone screen",
    promptGuidelines: ["Use puppet_swipe to scroll or swipe on the phone."],
    parameters: Type.Object({
      x1: Type.Number(),
      y1: Type.Number(),
      x2: Type.Number(),
      y2: Type.Number(),
      duration: Type.Optional(Type.Number({ description: "swipe duration in ms", default: 400 })),
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const r = await sendCommand(params.device, "swipe", {
        x1: params.x1,
        y1: params.y1,
        x2: params.x2,
        y2: params.y2,
        duration: params.duration ?? 400,
      });
      return ok(`swipe (${params.x1},${params.y1})→(${params.x2},${params.y2}): ${describe(r)}`, r);
    },
  });

  pi.registerTool({
    name: "puppet_key",
    label: "Puppet Key",
    description: "Send a system key: back, home, recents, enter.",
    promptSnippet: "Send a system key (back/home/recents/enter)",
    promptGuidelines: ["Use puppet_key to send system keys like back or home."],
    parameters: Type.Object({
      key: Type.Union([
        Type.Literal("back"),
        Type.Literal("home"),
        Type.Literal("recents"),
        Type.Literal("enter"),
      ]),
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const r = await sendCommand(params.device, "keyevent", { key: params.key });
      return ok(`key ${params.key}: ${describe(r)}`, r);
    },
  });

  pi.registerTool({
    name: "puppet_wait",
    label: "Puppet Wait",
    description:
      "Block until a find-spec matches the phone screen (or until timeout). Returns the screen text at match time. The reliable replacement for fixed sleeps.",
    promptSnippet: "Wait until text appears on the phone",
    promptGuidelines: [
      "Use puppet_wait instead of fixed sleeps to wait until expected content appears on the phone.",
    ],
    parameters: Type.Object({
      text: Type.Optional(Type.String()),
      contains: Type.Optional(Type.Boolean()),
      resourceId: Type.Optional(Type.String()),
      contentDesc: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number({ default: 15000 })),
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const match: Record<string, unknown> = {};
      if (params.text !== undefined) match.text = params.text;
      if (params.contains !== undefined) match.contains = params.contains;
      if (params.resourceId !== undefined) match.resourceId = params.resourceId;
      if (params.contentDesc !== undefined) match.contentDesc = params.contentDesc;
      const r = await waitForMatch(params.device, match, params.timeoutMs ?? 15000);
      if (r.matched) {
        return ok(`matched: ${JSON.stringify(match)}\n\n${r.screen ?? ""}`, r);
      }
      return ok(`TIMEOUT waiting for ${JSON.stringify(match)}\n\n${r.screen ?? ""}`, r);
    },
  });

  pi.registerTool({
    name: "puppet_refresh",
    label: "Puppet Refresh",
    description: "Ask the bridge app to re-dump the current screen immediately.",
    promptSnippet: "Refresh the phone screen dump",
    promptGuidelines: ["Use puppet_refresh to force a fresh screen dump when the view seems stale."],
    parameters: Type.Object({
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      await refreshScreen(params.device);
      const s = await fetchScreen(params.device, 40);
      return ok(`refreshed — ${s.pkg ?? "?"} · ${s.entries.length} nodes\n\n${s.text}`, s);
    },
  });

  pi.registerTool({
    name: "puppet_send_file",
    label: "Puppet Send File",
    description:
      "Send a local file (image/video/etc) to the phone's bridge cache so it can be attached or shared. Returns a fileId (and the on-device name) for puppet_share.",
    promptSnippet: "Send a local image/video to the phone",
    promptGuidelines: [
      "Use puppet_send_file to push a local image/video to the phone, then puppet_share to hand it to an app (e.g. the X composer).",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "local file path" }),
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const r = await uploadToDevice(params.device, params.path);
      const kb = (r.size / 1024).toFixed(1);
      return ok(
        `uploaded ${r.name} (${kb} KiB, ${r.mime}) → phone ${r.phonePath}\nfileId: ${r.fileId}`,
        r,
      );
    },
  });

  pi.registerTool({
    name: "puppet_share",
    label: "Puppet Share",
    description:
      "Share a file already on the phone (name/fileId from puppet_send_file) to an app. targetPackage com.twitter.android opens the X composer with the media attached; omit it for the system chooser.",
    promptSnippet: "Share a sent file to an app (e.g. the X composer)",
    promptGuidelines: [
      "Use puppet_share after puppet_send_file to hand the file to an app; targetPackage com.twitter.android opens the X composer with the media attached.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "on-device file name from puppet_send_file" })),
      fileId: Type.Optional(Type.String({ description: "fallback filename if no name given" })),
      mime: Type.Optional(Type.String()),
      targetPackage: Type.Optional(Type.String({ description: "e.g. com.twitter.android (default: chooser)" })),
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const cmdParams: Record<string, unknown> = {};
      if (params.name !== undefined) cmdParams.name = params.name;
      if (params.fileId !== undefined) cmdParams.fileId = params.fileId;
      if (params.mime !== undefined) cmdParams.mime = params.mime;
      if (params.targetPackage !== undefined) cmdParams.targetPackage = params.targetPackage;
      const r = await sendCommand(params.device, "shareFile", cmdParams);
      return ok(`share: ${describe(r)}`, r);
    },
  });

  pi.registerTool({
    name: "puppet_panic",
    label: "Puppet Panic",
    description:
      "Kill switch: send the phone HOME and lock the screen. Use when a flow goes wrong.",
    promptSnippet: "Panic: home + lock the phone",
    promptGuidelines: ["Use puppet_panic to stop a runaway flow: HOME + lock screen."],
    parameters: Type.Object({
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const d = await pickDevice(params.device);
      await api(`/devices/${encodeURIComponent(d.id)}/panic`, { json: {} });
      return ok(`panic sent to ${d.id}`);
    },
  });
}
