import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  A11yEvent,
  CommandEnvelope,
  DeviceCaps,
  DeviceInfo,
  FlatEntry,
  ResultEnvelope,
  ScreenSize,
  ScreenState,
  TreeNode,
  WaitMatch,
  WindowTag,
} from "./types.js";
import { entriesToText, flattenTree, matchEntries } from "./flatten.js";
import { SessionLog } from "./log.js";

interface Pending {
  timer: NodeJS.Timeout;
  resolve: (r: unknown) => void;
}

interface QueuedCmd {
  cmdId: string;
  cmd: string;
  params: Record<string, unknown>;
  deadline: number;
  resolve: (r: unknown) => void;
}

const MAX_QUEUE = 8;
const EVENT_RING = 200;

/** Commands that don't touch the UI: they may run before the first tree arrives
 *  and they bypass the app's serial command queue. */
const READ_ONLY = new Set(["refresh", "screenshot", "getFile"]);

/** State for one phone: socket, latest screen, event ring, command queue. */
export class Device {
  id: string;
  name?: string;
  appVersion?: string;
  screen?: ScreenSize;
  caps?: DeviceCaps;
  ws: WebSocket | null = null;
  connected = false;
  ready = false;
  tree?: ScreenState;
  events: A11yEvent[] = [];
  nextEventSeq = 1;
  lastSeen?: number;
  pkg?: string;
  battery?: number;
  charging?: boolean;
  lastStatusAt?: number;

  private seq = 0;
  private treeWaiters: Array<() => void> = [];
  private pending = new Map<string, Pending>();
  private queue: QueuedCmd[] = [];
  private pumping = false;

  constructor(id: string, private log: SessionLog) {
    this.id = id;
  }

  /** A new WS connection arrived for this device. Invalidate the old tree: it
   *  describes a previous life of this device. */
  attach(ws: WebSocket): void {
    this.ws = ws;
    this.connected = true;
    this.lastSeen = Date.now();
    this.tree = undefined;
    this.ready = false;
    this.pkg = undefined;
  }

  detach(): void {
    this.connected = false;
    this.ws = null;
    this.ready = false;
    const fail = (r: (v: unknown) => void) =>
      r({ ok: false, error: "device_disconnected" });
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      fail(p.resolve);
    }
    this.pending.clear();
    for (const q of this.queue.splice(0)) fail(q.resolve);
    this.log.write({ kind: "device", id: this.id, action: "disconnect" });
  }

  hello(name?: string, appVersion?: string, screen?: ScreenSize, caps?: DeviceCaps): void {
    this.name = name;
    this.appVersion = appVersion;
    this.screen = screen;
    this.caps = caps;
    this.log.write({ kind: "device", id: this.id, action: "hello", name, appVersion, screen, caps });
  }

  onTree(
    nodes: TreeNode[],
    pkg?: string,
    screen?: ScreenSize,
    meta?: { truncated?: boolean; nodeCount?: number; windows?: WindowTag[] },
  ): void {
    this.seq += 1;
    const entries = flattenTree(nodes);
    this.tree = {
      seq: this.seq,
      pkg,
      entries,
      nodes,
      at: Date.now(),
      truncated: meta?.truncated,
      nodeCount: meta?.nodeCount,
      windows: meta?.windows,
    };
    this.ready = true;
    if (screen) this.screen = screen;
    // Wake anything blocked in /wait the moment a tree lands, instead of making it
    // discover the change on its next poll tick.
    const waiters = this.treeWaiters;
    this.treeWaiters = [];
    for (const w of waiters) w();
    this.pushEvent({ kind: "screen", pkg });
    this.log.write({
      kind: "tree",
      id: this.id,
      seq: this.seq,
      pkg,
      entries: entries.length,
      nodes: meta?.nodeCount ?? nodes.length,
      truncated: meta?.truncated,
    });
  }

  onEvent(e: { kind: A11yEvent["kind"]; text?: string; pkg?: string; cls?: string }): void {
    this.pushEvent(e);
    if (e.kind === "window" && e.pkg) this.pkg = e.pkg;
  }

  /** Periodic health/status from the app (battery, charging). */
  onStatus(battery?: number, charging?: boolean): void {
    this.battery = battery;
    this.charging = charging;
    this.lastStatusAt = Date.now();
  }

  private pushEvent(e: {
    kind: A11yEvent["kind"];
    text?: string;
    pkg?: string;
    cls?: string;
  }): void {
    this.events.push({ seq: this.nextEventSeq++, ts: Date.now(), ...e });
    if (this.events.length > EVENT_RING) {
      this.events.splice(0, this.events.length - EVENT_RING);
    }
  }

  /** Resolves when the next tree arrives (or after [timeoutMs], so a caller that
   *  races this against nothing else can't hang). */
  nextTree(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const fire = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(fire, timeoutMs);
      timer.unref?.();
      this.treeWaiters.push(fire);
    });
  }

  eventsSince(since: number): A11yEvent[] {
    return this.events.filter((e) => e.seq > since);
  }

  /** Enqueue a command; resolves with `{ ok, result?, error? }`. */
  sendCommand(cmd: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    return new Promise((resolve) => {
      if (!this.connected) return resolve({ ok: false, error: "device_disconnected" });
      if (!READ_ONLY.has(cmd) && !this.ready) return resolve({ ok: false, error: "device_not_ready" });
      if (this.queue.length >= MAX_QUEUE) return resolve({ ok: false, error: "queue_full" });
      this.queue.push({
        cmdId: randomUUID(),
        cmd,
        params,
        deadline: Date.now() + timeoutMs,
        resolve,
      });
      this.log.write({ kind: "command", id: this.id, cmd, params });
      this.pump();
    });
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    while (this.queue.length > 0 && this.connected) {
      const q = this.queue[0];
      const wait = q.deadline - Date.now();
      if (wait <= 0) {
        this.queue.shift();
        q.resolve({ ok: false, error: "timeout_queued" });
        continue;
      }
      const env: CommandEnvelope = { type: "cmd", cmdId: q.cmdId, cmd: q.cmd, params: q.params };
      try {
        this.ws!.send(JSON.stringify(env));
      } catch {
        this.queue.shift();
        q.resolve({ ok: false, error: "send_failed" });
        continue;
      }
      this.queue.shift();
      const timer = setTimeout(() => {
        this.pending.delete(q.cmdId);
        this.log.write({ kind: "command", id: this.id, cmdId: q.cmdId, outcome: "timeout" });
        q.resolve({ ok: false, error: "timeout", cmdId: q.cmdId });
      }, wait);
      this.pending.set(q.cmdId, { timer, resolve: q.resolve });
    }
    this.pumping = false;
  }

  onResult(res: ResultEnvelope): void {
    const p = this.pending.get(res.cmdId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(res.cmdId);
    this.log.write({
      kind: "command",
      id: this.id,
      cmdId: res.cmdId,
      outcome: res.ok ? "ok" : "error",
      error: res.error,
      result: res.result,
    });
    p.resolve({ ok: res.ok, result: res.result, error: res.error });
  }

  find(m: WaitMatch): FlatEntry | undefined {
    return this.tree ? matchEntries(this.tree.entries, m) : undefined;
  }

  screenText(limit = 200): { text: string; truncated: boolean } {
    return this.tree
      ? entriesToText(this.tree.entries, limit)
      : { text: "(no screen yet)", truncated: false };
  }

  info(): DeviceInfo {
    return {
      id: this.id,
      name: this.name,
      connected: this.connected,
      ready: this.ready,
      appVersion: this.appVersion,
      screen: this.screen,
      pkg: this.tree?.pkg,
      treeSeq: this.tree?.seq,
      treeAt: this.tree?.at,
      lastSeen: this.lastSeen,
      battery: this.battery,
      charging: this.charging,
      lastStatusAt: this.lastStatusAt,
      entries: this.tree?.entries.length ?? 0,
      caps: this.caps,
      truncated: this.tree?.truncated,
      nodeCount: this.tree?.nodeCount,
      windows: this.tree?.windows,
    };
  }
}
