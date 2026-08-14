export interface ScreenSize {
  w: number;
  h: number;
}

export interface TreeNode {
  id: number;
  text?: string;
  contentDesc?: string;
  resourceId?: string;
  className?: string;
  clickable?: boolean;
  visible: boolean;
  /** left, top, right, bottom in screen px */
  bounds: [number, number, number, number];
  children?: TreeNode[];
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
}

export interface ScreenState {
  seq: number;
  pkg?: string;
  entries: FlatEntry[];
  nodes: TreeNode[];
  at: number; // epoch ms
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
  entries: number;
}
