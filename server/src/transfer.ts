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
  const size = await new Promise<number>((resolve, reject) => {
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

function startSweeper(): void {
  setInterval(async () => {
    try {
      const entries = await readdir(dir);
      const now = Date.now();
      for (const e of entries) {
        if (!e.endsWith(".json")) continue;
        try {
          const meta = JSON.parse(await readFile(join(dir, e), "utf8")) as TransferMeta;
          if (now - meta.createdAt > TTL_MS) {
            await rm(join(dir, e), { force: true });
            await rm(join(dir, meta.fileId), { force: true });
          }
        } catch {
          /* ignore corrupt meta */
        }
      }
    } catch {
      /* ignore */
    }
  }, 10 * 60 * 1000).unref();
}
