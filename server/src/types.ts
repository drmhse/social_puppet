export interface ScreenSize {
  w: number;
  h: number;
  orientation?: "portrait" | "landscape";
  density?: number;
}

/** Which window a root node belongs to (active app, IME, system dialog, …). */
export interface WindowTag {
  id: number;
  type: string;
  active: boolean;
  pkg?: string | null;
  nodes?: number;
}

/** What the connected app/OS supports, reported in `hello`. */
export interface DeviceCaps {
  screenshot?: boolean;
  imeEnter?: boolean;
  dpadKeys?: boolean;
  lockScreen?: boolean;
  multiWindow?: boolean;
  maxNodes?: number;
  sdk?: number;
}

export interface TreeNode {
  id: number;
  // The bridge app serializes missing values as JSON null, so these are nullable.
  text?: string | null;
  contentDesc?: string | null;
  resourceId?: string | null;
  className?: string | null;
  clickable?: boolean;
  visible: boolean;
  /** left, top, right, bottom in screen px */
  bounds: [number, number, number, number];
  children?: TreeNode[];
  /** Present on window roots only. */
  window?: WindowTag | null;
}

export interface FlatEntry {
  id: number;
  text?: string;
  desc?: string;
  resourceId?: string;
  cls?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  clickable: boolean;
  /** Window type when the node is NOT in the active window (ime, system, …). */
  win?: string;
}

export interface ScreenState {
  seq: number;
  pkg?: string;
  entries: FlatEntry[];
  nodes: TreeNode[];
  at: number; // epoch ms
  /** The app hit its node budget — absence of a match may just mean "past the cut". */
  truncated?: boolean;
  nodeCount?: number;
  windows?: WindowTag[];
}

export interface A11yEvent {
  seq: number;
  ts: number;
  kind: "window" | "node" | "screen";
  text?: string;
  pkg?: string;
  cls?: string;
}

export interface FindSpec {
  text?: string;
  contains?: boolean;
  resourceId?: string;
  contentDesc?: string;
}

export interface WaitMatch {
  text?: string;
  contains?: boolean;
  resourceId?: string;
  contentDesc?: string;
}

export interface CommandEnvelope {
  type: "cmd";
  cmdId: string;
  cmd: string;
  params: Record<string, unknown>;
}

export interface ResultEnvelope {
  type: "result";
  cmdId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface HelloMessage {
  type: "hello";
  deviceId: string;
  name?: string;
  appVersion?: string;
  screen?: ScreenSize;
  caps?: DeviceCaps;
}

export interface DeviceInfo {
  id: string;
  name?: string;
  connected: boolean;
  ready: boolean;
  appVersion?: string;
  screen?: ScreenSize;
  pkg?: string;
  treeSeq?: number;
  treeAt?: number;
  lastSeen?: number;
  battery?: number;
  charging?: boolean;
  lastStatusAt?: number;
  entries: number;
  caps?: DeviceCaps;
  truncated?: boolean;
  nodeCount?: number;
  windows?: WindowTag[];
}
