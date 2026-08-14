import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  WriteStream,
} from "node:fs";
import { join } from "node:path";

/** Append-only JSONL record of everything interesting: connects, trees, commands,
 *  results, waits.
 *
 *  A long-lived bridge writes continuously, so the log is bounded twice: each file
 *  rotates once past MAX_BYTES, and old session files are swept at startup. Without
 *  both, a server left running for weeks fills its disk and takes the bridge down
 *  with it. */

const MAX_BYTES = 32 * 1024 * 1024;
const KEEP_FILES = 20;
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

export class SessionLog {
  private ws?: WriteStream;
  private path?: string;
  private bytes = 0;

  constructor(private dir?: string) {
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      this.sweep();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.path = join(dir, `session-${stamp}.jsonl`);
      this.ws = createWriteStream(this.path, { flags: "a" });
    } catch (e) {
      console.warn(`[log] cannot open log dir ${dir}: ${e}`);
    }
  }

  write(ev: Record<string, unknown>): void {
    if (!this.ws) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...ev }) + "\n";
    this.bytes += Buffer.byteLength(line);
    this.ws.write(line);
    if (this.bytes >= MAX_BYTES) this.rotate();
  }

  /** Keep exactly one previous file per session: `.jsonl` becomes `.jsonl.1`, and an
   *  existing `.1` is dropped. Bounded by construction rather than by a policy that
   *  has to be remembered. */
  private rotate(): void {
    if (!this.ws || !this.path) return;
    const path = this.path;
    this.ws.end();
    this.bytes = 0;
    try {
      rmSync(`${path}.1`, { force: true });
      renameSync(path, `${path}.1`);
    } catch (e) {
      console.warn(`[log] rotation failed: ${e}`);
    }
    this.ws = createWriteStream(path, { flags: "a" });
  }

  /** Drop session logs that are old or simply too numerous; a restart loop would
   *  otherwise leave one file per restart forever. */
  private sweep(): void {
    if (!this.dir) return;
    const dir = this.dir;
    let files: Array<{ path: string; mtime: number }>;
    try {
      files = readdirSync(dir)
        .filter((f) => f.startsWith("session-") && f.includes(".jsonl"))
        .map((f) => join(dir, f))
        .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return;
    }
    const now = Date.now();
    for (const [i, f] of files.entries()) {
      if (i >= KEEP_FILES || now - f.mtime > KEEP_MS) {
        rmSync(f.path, { force: true });
      }
    }
  }

  close(): void {
    this.ws?.end();
  }
}
