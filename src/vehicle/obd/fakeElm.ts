import type { ObdTransport } from './elm327.ts';

/** A reply body, nothing at all (the adapter hangs), or a function of how many times the command was sent. */
export type FakeReply = string | null | ((count: number) => string | null);

export interface FakeElmOptions {
  /** Split replies into chunks of this many characters, as BLE notifications do. 0 = one chunk. */
  chunkSize?: number;
  /** Reply after this many ms instead of on the next microtask. */
  delayMs?: number;
}

/** "Supported PIDs" reply for a 0100/0120/0140 request. */
export function bitmapReply(base: number, pids: number[]): string {
  const bytes = [0, 0, 0, 0];
  for (const pid of pids) {
    const i = pid - base - 1;
    if (i >= 0 && i < 32) bytes[i >> 3] |= 0x80 >> (i & 7);
  }
  return `41${base.toString(16).padStart(2, '0').toUpperCase()}${bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
}

/** Scripted ELM327 for tests and for trying the OBD flow without a car: echoes until ATE0, ends replies with '>'. */
export class FakeElm implements ObdTransport {
  readonly writes: string[] = [];
  closed = false;
  private echo = true;
  private readonly counts = new Map<string, number>();
  private readonly listeners = new Set<(chunk: string) => void>();

  constructor(
    private readonly replies: Record<string, FakeReply>,
    private readonly opts: FakeElmOptions = {},
  ) {}

  async write(text: string): Promise<void> {
    if (this.closed) throw new Error('closed');
    this.writes.push(text);
    const command = text.replace(/\r$/, '').trim().toUpperCase();
    const count = (this.counts.get(command) ?? 0) + 1;
    this.counts.set(command, count);
    const reply = command in this.replies ? this.replies[command] : command.startsWith('AT') ? 'OK' : 'NO DATA';
    const body = typeof reply === 'function' ? reply(count) : reply;
    const echoed = this.echo;
    if (command === 'ATE0') this.echo = false;
    if (body === null) return;
    const full = `${echoed ? `${command}\r` : ''}${body.replace(/\n/g, '\r')}\r\r>`;
    const size = this.opts.chunkSize || full.length;
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += size) chunks.push(full.slice(i, i + size));
    const deliver = () => {
      for (const chunk of chunks) for (const l of this.listeners) l(chunk);
    };
    if (this.opts.delayMs) setTimeout(deliver, this.opts.delayMs);
    else queueMicrotask(deliver);
  }

  /** Pushes unsolicited bytes, e.g. a reply that arrives after its timeout. */
  inject(chunk: string): void {
    for (const l of this.listeners) l(chunk);
  }

  onData(cb: (chunk: string) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  sent(command: string): number {
    return this.counts.get(command) ?? 0;
  }
}
