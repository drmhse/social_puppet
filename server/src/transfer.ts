import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Side channel for file transfer: pi uploads here, the phone downloads from
 *  here (over the same tunnel/network it uses for the WS). Bytes never cross
 *  the WebSocket. Files are TTL'd and swept. */

const MAX_TRANSFER = 700 * 1024 * 1024; // X's video ceiling is ~512MB; leave headroom
const TTL_MS = 60 * 60 * 1000;
/** Ceiling for the whole staging directory. The TTL alone bounds nothing over a
 *  short interval: a script uploading videos in a loop can fill a disk long before
 *  the first file expires. */
const MAX_DIR_BYTES = 4 * 1024 * 1024 * 1024;

export interface TransferMeta {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
}

let dir = "";

export async function initTransferDir(d: string): Promise<void> {
  dir = d;
  await mkdir(dir, { recursive: true });
  startSweeper();
}

export function transferIdOk(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function transferFilePath(id: string): string {
  return join(dir, id);
}

function transferMetaPath(id: string): string {
  return join(dir, `${id}.json`);
}

/** Stream the request body to disk (no in-memory buffering — videos are big). */
export async function saveTransfer(
  req: IncomingMessage,
  name: string,
  mime: string,
): Promise<TransferMeta> {
  const fileId = randomUUID();
  const file = transferFilePath(fileId);
  let size: number;
  try {
    size = await new Promise<number>((resolve, reject) => {
      const out = createWriteStream(file);
      let n = 0;
      req.on("data", (c: Buffer) => {
        n += c.length;
        if (n > MAX_TRANSFER) {
          out.destroy(new Error("transfer too large"));
          req.destroy();
        }
      });
      req.pipe(out);
      out.on("finish", () => resolve(n));
      out.on("error", reject);
      req.on("error", reject);
    });
  } catch (e) {
    // An aborted or oversized upload has already written part of its body; leaving
    // it behind creates a blob with no metadata that nothing would ever delete.
    await rm(file, { force: true });
    throw e;
  }
  const meta: TransferMeta = {
    fileId,
    name: name.slice(0, 255),
    mime,
    size,
    createdAt: Date.now(),
  };
  await writeFile(transferMetaPath(fileId), JSON.stringify(meta));
  return meta;
}

export async function loadTransferMeta(id: string): Promise<TransferMeta | null> {
  try {
    const raw = await readFile(transferMetaPath(id), "utf8");
    return JSON.parse(raw) as TransferMeta;
  } catch {
    return null;
  }
}

/** Stream a stored transfer to the response. Returns false if the file is gone. */
export function streamTransfer(res: ServerResponse, id: string, meta: TransferMeta): boolean {
  const file = transferFilePath(id);
  if (!existsSync(file)) return false;
  res.writeHead(200, {
    "content-type": meta.mime,
    "content-length": statSync(file).size,
    "x-file-name": encodeURIComponent(meta.name),
  });
  createReadStream(file).pipe(res);
  return true;
}

async function sweep(): Promise<void> {
  const entries = await readdir(dir);
  const now = Date.now();
  const live: Array<{ id: string; createdAt: number; size: number }> = [];
  const known = new Set<string>();

  for (const e of entries) {
    if (!e.endsWith(".json")) continue;
    const id = e.slice(0, -".json".length);
    known.add(id);
    try {
      const meta = JSON.parse(await readFile(join(dir, e), "utf8")) as TransferMeta;
      if (now - meta.createdAt > TTL_MS) {
        await rm(join(dir, e), { force: true });
        await rm(transferFilePath(meta.fileId), { force: true });
        known.delete(id);
      } else {
        live.push({ id: meta.fileId, createdAt: meta.createdAt, size: meta.size });
      }
    } catch {
      /* corrupt meta: treat the pair as garbage */
      await rm(join(dir, e), { force: true });
      await rm(transferFilePath(id), { force: true });
      known.delete(id);
    }
  }

  // Blobs whose metadata never landed (a crash between the two writes) are
  // invisible to the loop above and would otherwise stay forever.
  for (const e of entries) {
    if (e.endsWith(".json") || known.has(e)) continue;
    const path = join(dir, e);
    try {
      if (now - statSync(path).mtimeMs > TTL_MS) await rm(path, { force: true });
    } catch {
      /* ignore */
    }
  }

  // Still over budget: drop oldest first until under it.
  let total = live.reduce((n, f) => n + f.size, 0);
  if (total <= MAX_DIR_BYTES) return;
  for (const f of live.sort((a, b) => a.createdAt - b.createdAt)) {
    if (total <= MAX_DIR_BYTES) break;
    await rm(transferMetaPath(f.id), { force: true });
    await rm(transferFilePath(f.id), { force: true });
    total -= f.size;
  }
}

function startSweeper(): void {
  const run = () => {
    sweep().catch(() => {
      /* a failed sweep is retried on the next tick */
    });
  };
  run();
  setInterval(run, 10 * 60 * 1000).unref();
}
