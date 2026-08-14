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
import { createReadStream, createWriteStream, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
  caps?: Record<string, unknown>;
  screen?: { w: number; h: number; orientation?: string };
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
  /** This response hit its line `limit`. */
  truncated?: boolean;
  /** The DEVICE hit its node budget: the screen itself is incomplete. */
  treeTruncated?: boolean;
  nodeCount?: number;
  windows?: Array<{ id: number; type: string; active: boolean; pkg?: string | null; nodes?: number }>;
  screen?: { w: number; h: number; orientation?: string; density?: number };
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
  const size = statSync(filePath).size;
  const name = basename(filePath);
  const mime = mimeFor(filePath) ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": mime,
    "x-file-name": encodeURIComponent(name),
    "x-file-mime": mime,
    "x-file-size": String(size),
    "content-length": String(size),
  };
  if (TOKEN) headers["authorization"] = `Bearer ${TOKEN}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  let res: Response;
  try {
    res = await fetch(`${SERVER}/api/v1/transfer`, {
      method: "POST",
      headers,
      // Stream from disk. Reading a video into a Buffer first would put the whole
      // file (up to the server's 700MB ceiling) in this process's heap.
      body: Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit & { duplex: "half" });
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

/** Stream a staged transfer from the server to a local path. */
export async function downloadTransfer(fileId: string, outPath: string): Promise<number> {
  const headers: Record<string, string> = {};
  if (TOKEN) headers["authorization"] = `Bearer ${TOKEN}`;
  const res = await fetch(`${SERVER}/transfer/${encodeURIComponent(fileId)}`, { headers });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(
    Readable.fromWeb(res.body as never),
    createWriteStream(outPath) as unknown as Writable,
  );
  return statSync(outPath).size;
}

export interface ShotResult {
  path: string;
  fileId: string;
  size: number;
  w?: number;
  h?: number;
  mime?: string;
}

/**
 * Take a screenshot on the phone and bring it back to this machine. The phone
 * stages the image on the server over HTTP (never over the WebSocket) and we pull
 * it from there.
 */
export async function screenshot(
  device: string | undefined,
  opts: { outPath?: string; format?: string; quality?: number; maxDim?: number } = {},
): Promise<ShotResult> {
  const r = await sendCommand(
    device,
    "screenshot",
    {
      ...(opts.format ? { format: opts.format } : {}),
      ...(opts.quality ? { quality: opts.quality } : {}),
      ...(opts.maxDim ? { maxDim: opts.maxDim } : {}),
    },
    60_000,
  );
  if (!r.ok) throw new Error(r.error ?? "screenshot failed");
  const res = (r.result ?? {}) as { fileId?: string; name?: string; mime?: string; w?: number; h?: number };
  if (!res.fileId) throw new Error("screenshot returned no fileId");
  const out = opts.outPath ?? join(tmpdir(), res.name ?? `screen-${Date.now()}.webp`);
  const size = await downloadTransfer(res.fileId, out);
  return { path: out, fileId: res.fileId, size, w: res.w, h: res.h, mime: res.mime };
}

/** Pull a file out of the phone's bridge cache onto this machine. */
export async function fetchFromDevice(
  device: string | undefined,
  name: string,
  outPath?: string,
): Promise<{ path: string; size: number; mime?: string }> {
  const r = await sendCommand(device, "getFile", { name }, 300_000);
  if (!r.ok) throw new Error(r.error ?? "getFile failed");
  const res = (r.result ?? {}) as { fileId?: string; name?: string; mime?: string };
  if (!res.fileId) throw new Error("getFile returned no fileId");
  const out = outPath ?? join(tmpdir(), res.name ?? name);
  const size = await downloadTransfer(res.fileId, out);
  return { path: out, size, mime: res.mime };
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
      const extraWindows = (s.windows ?? []).filter((w) => !w.active);
      const head =
        `${s.pkg ?? "?"} · seq ${s.seq ?? "?"} · ${s.entries.length} nodes` +
        `${s.stale ? " (STALE)" : ""}${s.truncated ? " (line limit hit)" : ""}` +
        // Two different truncations, and only this one means "the phone didn't send
        // you the whole screen" — worth saying out loud, not hiding in a field.
        `${s.treeTruncated ? ` (DEVICE NODE BUDGET HIT — screen incomplete, ${s.nodeCount} nodes)` : ""}` +
        `${extraWindows.length ? ` · also on screen: ${extraWindows.map((w) => w.type).join(", ")}` : ""}`;
      return ok(`${head}\n\n${s.text}`, {
        pkg: s.pkg,
        entries: s.entries,
        windows: s.windows,
        screen: s.screen,
      });
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
      xn: Type.Optional(Type.Number({ description: "normalized x, 0..1 — portable across devices/rotation" })),
      yn: Type.Optional(Type.Number({ description: "normalized y, 0..1" })),
      text: Type.Optional(Type.String()),
      contains: Type.Optional(Type.Boolean()),
      resourceId: Type.Optional(Type.String()),
      contentDesc: Type.Optional(Type.String()),
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const { device, x, y, xn, yn, ...rest } = params;
      const params2: Record<string, unknown> = {};
      if (x !== undefined && y !== undefined) {
        params2.x = x;
        params2.y = y;
      } else if (xn !== undefined && yn !== undefined) {
        params2.xn = xn;
        params2.yn = yn;
      } else {
        const find: Record<string, unknown> = {};
        if (rest.text !== undefined) find.text = rest.text;
        if (rest.contains !== undefined) find.contains = rest.contains;
        if (rest.resourceId !== undefined) find.resourceId = rest.resourceId;
        if (rest.contentDesc !== undefined) find.contentDesc = rest.contentDesc;
        if (Object.keys(find).length === 0) {
          return ok("puppet_tap needs x+y, xn+yn (0..1), or at least one find field", {});
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
      "Type text on the phone. If `into` (find-spec) is given, set the text into that field; otherwise the focused field is used. " +
      "`mode`: replace (default) / append / clear. `perChar` grows the field one character at a time so search-as-you-type and " +
      "@mention autocomplete actually fire (slower). `submit` presses the keyboard's action key (Search/Send/Go) afterwards.",
    promptSnippet: "Type text into the phone",
    promptGuidelines: [
      "Use puppet_type to enter text into the phone, with an optional `into` find-spec.",
      "If a field's autocomplete or search-as-you-type must react (mentions, search suggestions), pass perChar: true.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "text to type (ignored when mode=clear)" }),
      into: Type.Optional(
        Type.Object({
          text: Type.Optional(Type.String()),
          contains: Type.Optional(Type.Boolean()),
          resourceId: Type.Optional(Type.String()),
          contentDesc: Type.Optional(Type.String()),
        }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("replace"), Type.Literal("append"), Type.Literal("clear")], {
          description: "replace (default), append to what's there, or clear the field",
        }),
      ),
      perChar: Type.Optional(
        Type.Boolean({ description: "type character by character so the app's text watchers fire" }),
      ),
      charDelayMs: Type.Optional(Type.Number({ description: "delay between characters (default 30)" })),
      submit: Type.Optional(Type.Boolean({ description: "press the field's IME action key after typing" })),
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const body: Record<string, unknown> = { text: params.text };
      if (params.into) body.find = params.into;
      if (params.mode) body.mode = params.mode;
      if (params.perChar) body.perChar = true;
      if (params.charDelayMs !== undefined) body.charDelayMs = params.charDelayMs;
      if (params.submit) body.submit = true;
      const perCharBudget = params.perChar ? 15_000 + params.text.length * 200 : 20_000;
      const r = await sendCommand(params.device, "setText", body, perCharBudget);
      return ok(`type "${params.text}"${params.mode ? ` (${params.mode})` : ""}: ${describe(r)}`, r);
    },
  });

  pi.registerTool({
    name: "puppet_swipe",
    label: "Puppet Swipe",
    description: "Swipe between two screen points on the phone.",
    promptSnippet: "Swipe on the phone screen",
    promptGuidelines: ["Use puppet_swipe to scroll or swipe on the phone."],
    parameters: Type.Object({
      x1: Type.Optional(Type.Number()),
      y1: Type.Optional(Type.Number()),
      x2: Type.Optional(Type.Number()),
      y2: Type.Optional(Type.Number()),
      x1n: Type.Optional(Type.Number({ description: "normalized start x, 0..1" })),
      y1n: Type.Optional(Type.Number({ description: "normalized start y, 0..1" })),
      x2n: Type.Optional(Type.Number({ description: "normalized end x, 0..1" })),
      y2n: Type.Optional(Type.Number({ description: "normalized end y, 0..1" })),
      duration: Type.Optional(Type.Number({ description: "swipe duration in ms", default: 400 })),
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const body: Record<string, unknown> = { duration: params.duration ?? 400 };
      for (const k of ["x1", "y1", "x2", "y2", "x1n", "y1n", "x2n", "y2n"] as const) {
        if (params[k] !== undefined) body[k] = params[k];
      }
      const havePx = ["x1", "y1", "x2", "y2"].every((k) => body[k] !== undefined);
      const haveNorm = ["x1n", "y1n", "x2n", "y2n"].every((k) => body[k] !== undefined);
      if (!havePx && !haveNorm) {
        return ok("puppet_swipe needs x1,y1,x2,y2 (px) or x1n,y1n,x2n,y2n (0..1)", {});
      }
      const r = await sendCommand(params.device, "swipe", body);
      return ok(`swipe ${JSON.stringify(body)}: ${describe(r)}`, r);
    },
  });

  pi.registerTool({
    name: "puppet_key",
    label: "Puppet Key",
    description:
      "Send a system key: back, home, recents, enter (the focused field's IME action), notifications, quickSettings, " +
      "lock, or a d-pad direction (dpadUp/Down/Left/Right/Center, Android 13+). Arbitrary key codes are not available " +
      "to an accessibility service — this is the whole set.",
    promptSnippet: "Send a system key (back/home/recents/enter/…)",
    promptGuidelines: ["Use puppet_key to send system keys like back, home, or the keyboard's enter/search action."],
    parameters: Type.Object({
      key: Type.Union([
        Type.Literal("back"),
        Type.Literal("home"),
        Type.Literal("recents"),
        Type.Literal("enter"),
        Type.Literal("notifications"),
        Type.Literal("quickSettings"),
        Type.Literal("lock"),
        Type.Literal("dpadUp"),
        Type.Literal("dpadDown"),
        Type.Literal("dpadLeft"),
        Type.Literal("dpadRight"),
        Type.Literal("dpadCenter"),
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
    name: "puppet_scroll",
    label: "Puppet Scroll",
    description:
      "Scroll the screen one step. `direction` names how you move THROUGH the content: down = further down the feed. " +
      "Asks the scrollable container to scroll itself (one page) and falls back to a swipe gesture if there isn't one.",
    promptSnippet: "Scroll the phone screen one step",
    promptGuidelines: ["Use puppet_scroll for ordinary scrolling; puppet_swipe is for gestures that aren't scrolls."],
    parameters: Type.Object({
      direction: Type.Optional(
        Type.Union([Type.Literal("down"), Type.Literal("up"), Type.Literal("left"), Type.Literal("right")]),
      ),
      distance: Type.Optional(Type.Number({ description: "gesture fallback distance in px (default 600)" })),
      gesture: Type.Optional(Type.Boolean({ description: "force the swipe gesture instead of the container action" })),
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const r = await sendCommand(params.device, "scroll", {
        direction: params.direction ?? "down",
        ...(params.distance !== undefined ? { distance: params.distance } : {}),
        ...(params.gesture ? { gesture: true } : {}),
      });
      return ok(`scroll ${params.direction ?? "down"}: ${describe(r)}`, r);
    },
  });

  pi.registerTool({
    name: "puppet_scroll_to",
    label: "Puppet Scroll To",
    description:
      "Scroll until a find-spec is on screen (or the scroll budget runs out). The accessibility tree only contains what is " +
      "rendered, so 'not found' in one dump says nothing about a long list — this does the scroll-and-recheck loop on the " +
      "phone instead of one round-trip per swipe.",
    promptSnippet: "Scroll until something appears on the phone",
    promptGuidelines: [
      "Use puppet_scroll_to to reach content that is off-screen in a list, instead of repeated puppet_swipe + puppet_screen.",
    ],
    parameters: Type.Object({
      text: Type.Optional(Type.String()),
      contains: Type.Optional(Type.Boolean()),
      resourceId: Type.Optional(Type.String()),
      contentDesc: Type.Optional(Type.String()),
      direction: Type.Optional(
        Type.Union([Type.Literal("down"), Type.Literal("up"), Type.Literal("left"), Type.Literal("right")]),
      ),
      maxScrolls: Type.Optional(Type.Number({ description: "scroll attempts before giving up (default 8, max 30)" })),
      distance: Type.Optional(Type.Number({ description: "gesture fallback distance in px (default 800)" })),
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const find: Record<string, unknown> = {};
      if (params.text !== undefined) find.text = params.text;
      if (params.contains !== undefined) find.contains = params.contains;
      if (params.resourceId !== undefined) find.resourceId = params.resourceId;
      if (params.contentDesc !== undefined) find.contentDesc = params.contentDesc;
      if (Object.keys(find).length === 0) {
        return ok("puppet_scroll_to needs at least one of text / resourceId / contentDesc", {});
      }
      const maxScrolls = params.maxScrolls ?? 8;
      const r = await sendCommand(
        params.device,
        "scrollTo",
        {
          find,
          direction: params.direction ?? "down",
          maxScrolls,
          ...(params.distance !== undefined ? { distance: params.distance } : {}),
        },
        20_000 + maxScrolls * 2_000,
      );
      return ok(`scrollTo ${JSON.stringify(find)}: ${describe(r)}`, r);
    },
  });

  pi.registerTool({
    name: "puppet_screenshot",
    label: "Puppet Screenshot",
    description:
      "Take a real screenshot of the phone and save it locally. Use this for anything the accessibility tree cannot express: " +
      "unlabeled images, video frames, charts, verifying which photo got attached, or a layout question. Needs Android 11+. " +
      "FLAG_SECURE screens (banking, DRM video) cannot be captured by anyone and will fail or come back blank.",
    promptSnippet: "Screenshot the phone",
    promptGuidelines: [
      "Use puppet_screenshot when the answer is visual — images without labels, video, layout — since puppet_screen only returns text.",
    ],
    parameters: Type.Object({
      outPath: Type.Optional(Type.String({ description: "local path to write (default: a temp file)" })),
      format: Type.Optional(
        Type.Union([Type.Literal("webp"), Type.Literal("jpeg"), Type.Literal("png")], {
          description: "webp (default, smallest), jpeg, or png (lossless, ~10x bigger)",
        }),
      ),
      quality: Type.Optional(Type.Number({ description: "1..100 for lossy formats (default 80)" })),
      maxDim: Type.Optional(Type.Number({ description: "longest edge in px (default 1280)" })),
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const shot = await screenshot(params.device, {
        outPath: params.outPath,
        format: params.format,
        quality: params.quality,
        maxDim: params.maxDim,
      });
      const kb = (shot.size / 1024).toFixed(1);
      return ok(
        `screenshot ${shot.w ?? "?"}x${shot.h ?? "?"} (${kb} KiB) → ${shot.path}`,
        shot as unknown as object,
      );
    },
  });

  pi.registerTool({
    name: "puppet_get_file",
    label: "Puppet Get File",
    description:
      "Pull a file out of the phone's bridge cache to this machine (the counterpart of puppet_send_file). Limited to the " +
      "bridge app's own cache/files directories.",
    promptSnippet: "Fetch a file from the phone",
    promptGuidelines: ["Use puppet_get_file to retrieve a file the bridge app has in its cache."],
    parameters: Type.Object({
      name: Type.String({ description: "file name in the bridge cache" }),
      outPath: Type.Optional(Type.String({ description: "local path to write (default: a temp file)" })),
      device: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const r = await fetchFromDevice(params.device, params.name, params.outPath);
      return ok(`fetched ${params.name} (${(r.size / 1024).toFixed(1)} KiB) → ${r.path}`, r);
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
