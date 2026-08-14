import { createWriteStream, mkdirSync, WriteStream } from "node:fs";
import { join } from "node:path";

/** Append-only JSONL record of everything interesting: connects, trees, commands,
 *  results, waits. One file per server run. */
export class SessionLog {
  private ws?: WriteStream;

  constructor(dir?: string) {
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.ws = createWriteStream(join(dir, `session-${stamp}.jsonl`), {
        flags: "a",
      });
    } catch (e) {
      console.warn(`[log] cannot open log dir ${dir}: ${e}`);
    }
  }

  write(ev: Record<string, unknown>): void {
    if (!this.ws) return;
    this.ws.write(JSON.stringify({ ts: new Date().toISOString(), ...ev }) + "\n");
  }

  close(): void {
    this.ws?.end();
  }
}
