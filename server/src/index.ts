import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { Device } from "./devices.js";
import { SessionLog } from "./log.js";
import {
  initTransferDir,
  loadTransferMeta,
  saveTransfer,
  streamTransfer,
  transferIdOk,
} from "./transfer.js";
import { HelloMessage, ResultEnvelope, WaitMatch } from "./types.js";

const PORT = Number(process.env.PORT ?? 8743);
const TOKEN = process.env.SOCIAL_PUPPET_TOKEN ?? "";
const LOG_DIR = process.env.SOCIAL_PUPPET_LOG_DIR ?? join(process.cwd(), "data");
const LOGGING = process.env.SOCIAL_PUPPET_LOG !== "0";

if (TOKEN === "") {
  console.warn(
    "[social-puppet] SOCIAL_PUPPET_TOKEN is not set — the server is OPEN. Anyone on the network can drive connected phones. Set a token for anything beyond local dev.",
  );
}

const log = new SessionLog(LOGGING ? LOG_DIR : undefined);
void initTransferDir(join(LOG_DIR, "transfer"));
const devices = new Map<string, Device>();
const wsToDevice = new WeakMap<WebSocket, Device>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid json body"));
      }
    });
    req.on("error", reject);
  });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { error: { code: "unauthorized", message: "missing or bad token" } });
}

function authOk(req: IncomingMessage): boolean {
  if (!TOKEN) return true;
  const h = req.headers.authorization ?? "";
  return h === `Bearer ${TOKEN}` || req.headers["x-token"] === TOKEN;
}

function deviceOr404(res: ServerResponse, id: string): Device | undefined {
  const d = devices.get(id);
  if (!d) {
    sendJson(res, 404, { error: { code: "not_found", message: `no device '${id}'` } });
    return undefined;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleApi(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const seg = path.replace(/^\/+|\/+$/g, "").split("/");

  // GET /health
  if (seg[0] === "health" && seg.length === 1) {
    return sendJson(res, 200, { ok: true, devices: devices.size });
  }

  // POST /transfer — stage a file for the phone (raw body)
  if (seg[0] === "transfer" && seg.length === 1) {
    if (method !== "POST") return sendJson(res, 405, { error: { code: "method", message: "POST only" } });
    const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "file"));
    const mime = String(req.headers["x-file-mime"] ?? "application/octet-stream");
    const meta = await saveTransfer(req, name, mime);
    log.write({ kind: "transfer", fileId: meta.fileId, name: meta.name, mime: meta.mime, size: meta.size });
    return sendJson(res, 200, {
      fileId: meta.fileId,
      name: meta.name,
      mime: meta.mime,
      size: meta.size,
      url: `/transfer/${meta.fileId}`,
    });
  }

  // /devices[...]
  if (seg[0] !== "devices") {
    return sendJson(res, 404, { error: { code: "not_found", message: `no route ${path}` } });
  }
  if (seg.length === 1) {
    if (method !== "GET") return sendJson(res, 405, { error: { code: "method", message: "GET only" } });
    const list = [...devices.values()].map((d) => d.info());
    return sendJson(res, 200, list);
  }

  const id = seg[1];
  const sub = seg[2];
  const d = deviceOr404(res, id);
  if (!d) return;

  if (!sub) {
    if (method !== "GET") return sendJson(res, 405, { error: { code: "method", message: "GET only" } });
    return sendJson(res, 200, d.info());
  }

  if (sub === "screen") {
    if (method !== "GET") return sendJson(res, 405, { error: { code: "method", message: "GET only" } });
    const url = new URL(req.url ?? "/", "http://localhost");
    const raw = url.searchParams.get("raw") === "1";
    const limit = Math.max(0, Number(url.searchParams.get("limit") ?? 200) || 0);
    if (!d.tree) {
      return sendJson(res, 404, { error: { code: "no_screen_yet", message: "device connected but no tree received" } });
    }
    const { text, truncated } = d.screenText(limit);
    return sendJson(res, 200, {
      id: d.id,
      pkg: d.tree.pkg,
      seq: d.tree.seq,
      at: d.tree.at,
      stale: Date.now() - d.tree.at > 10_000,
      entries: d.tree.entries,
      text,
      truncated,
      // Distinct from `truncated` above (which is this response's line limit):
      // the DEVICE hit its node budget, so the screen itself is incomplete.
      treeTruncated: d.tree.truncated === true,
      nodeCount: d.tree.nodeCount,
      windows: d.tree.windows,
      screen: d.screen,
      ...(raw ? { nodes: d.tree.nodes } : {}),
    });
  }

  if (sub === "events") {
    if (method !== "GET") return sendJson(res, 405, { error: { code: "method", message: "GET only" } });
    const url = new URL(req.url ?? "/", "http://localhost");
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    const events = d.eventsSince(since);
    return sendJson(res, 200, { events, next: d.events[d.events.length - 1]?.seq ?? since });
  }

  if (sub === "refresh") {
    if (method !== "POST") return sendJson(res, 405, { error: { code: "method", message: "POST only" } });
    const result = (await d.sendCommand("refresh", {}, 5000)) as { ok: boolean; error?: string };
    if (!result.ok) return sendJson(res, 409, { error: { code: result.error, message: result.error } });
    return sendJson(res, 200, { ok: true });
  }

  if (sub === "command") {
    if (method !== "POST") return sendJson(res, 405, { error: { code: "method", message: "POST only" } });
    const body = (await readBody(req)) as {
      cmd?: string;
      params?: Record<string, unknown>;
      timeoutMs?: number;
    };
    const cmd = body.cmd;
    const known = [
      "launch",
      "tap",
      "setText",
      "swipe",
      "scroll",
      "scrollTo",
      "keyevent",
      "screenshot",
      "refresh",
      "panic",
      "putFile",
      "getFile",
      "shareFile",
    ];
    if (typeof cmd !== "string" || !known.includes(cmd)) {
      return sendJson(res, 400, { error: { code: "bad_command", message: `unknown command '${String(cmd)}'` } });
    }
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 15000, 500), 600000);
    const result = (await d.sendCommand(cmd, body.params ?? {}, timeoutMs)) as {
      ok: boolean;
      error?: string;
    };
    if (!result.ok && (result.error === "device_disconnected" || result.error === "device_not_ready")) {
      return sendJson(res, 409, { error: { code: result.error, message: result.error } });
    }
    return sendJson(res, 200, result);
  }

  if (sub === "wait") {
    if (method !== "POST") return sendJson(res, 405, { error: { code: "method", message: "POST only" } });
    const body = (await readBody(req)) as {
      match?: WaitMatch;
      present?: boolean;
      timeoutMs?: number;
    };
    const match = body.match ?? {};
    const present = body.present !== false;
    if (!match.text && !match.resourceId && !match.contentDesc) {
      return sendJson(res, 400, { error: { code: "bad_match", message: "match needs text, resourceId or contentDesc" } });
    }
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 15000, 500), 600000);
    const deadline = Date.now() + timeoutMs;
    let lastRefresh = 0;
    for (;;) {
      const found = d.find(match);
      if (present && found) {
        return sendJson(res, 200, { matched: true, entry: found, screen: d.screenText(200).text });
      }
      if (!present && !found) {
        return sendJson(res, 200, { matched: true, screen: d.screenText(200).text });
      }
      if (Date.now() >= deadline) {
        return sendJson(res, 200, { matched: false, screen: d.screenText(200).text });
      }
      // If the tree is stale, ask the app for a fresh dump (at most 1/s).
      if (d.connected && (!d.tree || Date.now() - d.tree.at > 2000) && Date.now() - lastRefresh > 1000) {
        lastRefresh = Date.now();
        void d.sendCommand("refresh", {}, 3000);
      }
      // Wake on the next tree push rather than on a fixed tick: a wait that would
      // have cost up to 300ms of polling latency now returns as soon as the phone
      // says the screen changed. The sleep is just the ceiling.
      await Promise.race([d.nextTree(300), sleep(300)]);
    }
  }

  if (sub === "panic") {
    if (method !== "POST") return sendJson(res, 405, { error: { code: "method", message: "POST only" } });
    void d.sendCommand("panic", {}, 2000);
    return sendJson(res, 200, { ok: true, sent: true, note: "panic dispatched (HOME + lock)" });
  }

  return sendJson(res, 404, { error: { code: "not_found", message: `no route ${path}` } });
}

const server = createServer(async (req, res) => {
  try {
    if (!authOk(req)) return unauthorized(res);
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, devices: devices.size });
    }
    if (url.pathname.startsWith("/transfer/")) {
      if ((req.method ?? "GET") !== "GET") {
        return sendJson(res, 405, { error: { code: "method", message: "GET only" } });
      }
      const id = url.pathname.slice("/transfer/".length);
      if (!transferIdOk(id)) {
        return sendJson(res, 404, { error: { code: "not_found", message: "no such transfer" } });
      }
      const meta = await loadTransferMeta(id);
      if (!meta) {
        return sendJson(res, 404, { error: { code: "not_found", message: "no such transfer" } });
      }
      if (!streamTransfer(res, id, meta)) {
        return sendJson(res, 404, { error: { code: "not_found", message: "file missing" } });
      }
      return;
    }
    if (!url.pathname.startsWith("/api/v1/")) {
      return sendJson(res, 404, { error: { code: "not_found", message: `no route ${url.pathname}` } });
    }
    const rest = url.pathname.slice("/api/v1/".length);
    await handleApi(req.method ?? "GET", rest, req, res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.write({ kind: "http_error", msg });
    if (!res.headersSent) sendJson(res, 400, { error: { code: "bad_request", message: msg } });
  }
});

// ---------------------------------------------------------------------------
// WebSocket (phones)
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (TOKEN && url.searchParams.get("token") !== TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws: WebSocket) => {
  ws.on("message", (data) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    const device = wsToDevice.get(ws);
    switch (msg.type) {
      case "hello": {
        const h = msg as unknown as HelloMessage;
        const d = devices.get(h.deviceId) ?? new Device(h.deviceId, log);
        devices.set(h.deviceId, d);
        wsToDevice.set(ws, d);
        d.attach(ws);
        d.hello(h.name, h.appVersion, h.screen, h.caps);
        log.write({ kind: "device", id: h.deviceId, action: "connect" });
        break;
      }
      case "tree": {
        const d = device;
        if (!d) return;
        const nodes = (msg.nodes ?? []) as never[];
        d.onTree(nodes, msg.pkg as string | undefined, msg.screen as never | undefined, {
          truncated: msg.truncated === true,
          nodeCount: typeof msg.nodeCount === "number" ? msg.nodeCount : undefined,
          windows: (msg.windows ?? undefined) as never,
        });
        break;
      }
      case "event": {
        const d = device;
        if (!d) return;
        d.onEvent({
          kind: msg.kind as "window" | "node",
          text: msg.text as string | undefined,
          pkg: msg.pkg as string | undefined,
          cls: msg.cls as string | undefined,
        });
        break;
      }
      case "status": {
        const d = device;
        if (!d) return;
        d.onStatus(
          typeof msg.battery === "number" ? msg.battery : undefined,
          typeof msg.charging === "boolean" ? msg.charging : undefined,
        );
        break;
      }
      case "result": {
        const d = device;
        if (!d) return;
        d.onResult(msg as unknown as ResultEnvelope);
        break;
      }
      case "pong": {
        const d = device;
        if (d) d.lastSeen = Date.now();
        break;
      }
    }
  });

  ws.on("pong", () => {
    const d = wsToDevice.get(ws);
    if (d) d.lastSeen = Date.now();
  });

  ws.on("close", () => {
    const d = wsToDevice.get(ws);
    wsToDevice.delete(ws);
    if (d && d.ws === ws) d.detach();
  });

  ws.on("error", () => {
    /* close handler does the cleanup */
  });
});

// Forget devices that have been gone for a day. Each install generates a fresh
// device id, so without this a phone reinstalled a few times leaves its old Device
// objects, and their last screen trees, in memory for the life of the process.
const DEVICE_TTL_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, d] of devices) {
    if (!d.connected && now - (d.lastSeen ?? 0) > DEVICE_TTL_MS) {
      devices.delete(id);
      log.write({ kind: "device", id, action: "forgotten" });
    }
  }
}, 60 * 60 * 1000).unref();

// Heartbeat: ping every 30s; a phone that hasn't said anything in 45s is gone.
setInterval(() => {
  const now = Date.now();
  for (const d of devices.values()) {
    if (!d.connected || !d.ws) continue;
    if (now - (d.lastSeen ?? 0) > 45_000) {
      log.write({ kind: "device", id: d.id, action: "heartbeat_timeout" });
      d.ws.terminate();
      continue;
    }
    try {
      d.ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30_000).unref();

server.listen(PORT, () => {
  console.log(`[social-puppet] server listening on http://0.0.0.0:${PORT}`);
  console.log(`[social-puppet] REST  http://127.0.0.1:${PORT}/api/v1/...`);
  console.log(`[social-puppet] WS    ws://<phone-can-reach-this-host>:${PORT}/?token=…`);
  if (TOKEN) console.log(`[social-puppet] token auth enabled`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n[social-puppet] ${sig} — shutting down`);
    log.close();
    process.exit(0);
  });
}
