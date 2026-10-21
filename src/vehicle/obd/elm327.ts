/** A byte stream to an ELM327-compatible OBD-II adapter (Bluetooth LE, classic Bluetooth or a test fake). */
export interface ObdTransport {
  /** Sends text as-is; the client includes the '\r' terminator. */
  write(text: string): Promise<void>;
  onData(cb: (chunk: string) => void): () => void;
  close(): Promise<void>;
}

export type ObdErrorCode =
  | 'timeout'
  | 'no_data'
  | 'unknown_command'
  | 'unable_to_connect'
  | 'stopped'
  | 'bus_error'
  | 'bad_response'
  | 'closed'
  | 'no_soc';

export const OBD_ERROR_MESSAGES: Record<ObdErrorCode, string> = {
  timeout: "The OBD-II adapter stopped answering. Check it's plugged in firmly and the car is switched on.",
  no_data: "The car didn't answer that request.",
  unknown_command: "The OBD-II adapter didn't understand a command. It may not be a genuine ELM327-compatible adapter.",
  unable_to_connect: "The adapter couldn't talk to the car. Switch the car on (ready mode) and try again.",
  stopped: 'The adapter was interrupted. Try again.',
  bus_error: 'The adapter reported a problem talking to the car. Unplug it, plug it back in and try again.',
  bad_response: 'The adapter sent a reply ChargeOne could not read.',
  closed: 'The OBD-II adapter is disconnected.',
  no_soc:
    "This car doesn't share battery % over the standard OBD-II port, so ChargeOne can only read speed. Phone tracking still works.",
};

export class ObdError extends Error {
  readonly code: ObdErrorCode;

  constructor(code: ObdErrorCode, message: string = OBD_ERROR_MESSAGES[code]) {
    super(message);
    this.name = 'ObdError';
    this.code = code;
  }
}

/** Standard mode 01 PIDs ChargeOne reads. */
export const PID = {
  speed: 0x0d,
  /** "Hybrid/EV battery pack remaining life": the BMS charge level on cars that report it. */
  evBatteryPct: 0x5b,
  ambientTemp: 0x46,
  moduleVoltage: 0x42,
} as const;

export const INIT_COMMANDS = ['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0'] as const;
/** Formatting commands some clones reject; the parser copes with spaces, linefeeds and headers either way. */
const OPTIONAL_INIT = new Set(['ATL0', 'ATS0', 'ATH0']);
const SUPPORTED_PID_QUERIES = [0x00, 0x20, 0x40] as const;

export interface Elm327Options {
  /** Per-command timeout, ms. */
  timeoutMs?: number;
  /** ATZ restarts the chip, which takes longer. */
  resetTimeoutMs?: number;
  /** The first request after ATSP0 searches for the car's protocol, which can take several seconds. */
  searchTimeoutMs?: number;
}

const ERROR_PATTERNS: Array<[RegExp, ObdErrorCode]> = [
  [/^NODATA$/, 'no_data'],
  [/^\?$/, 'unknown_command'],
  [/^UNABLETOCONNECT$/, 'unable_to_connect'],
  [/^STOPPED$/, 'stopped'],
  [/^(CANERROR|BUSERROR|BUSBUSY|BUFFERFULL|FBERROR|DATAERROR|LVRESET|ERR\d+|<RXERROR|<DATAERROR)/, 'bus_error'],
];

/** Response lines without echo, status chatter and blank lines. */
export function cleanResponse(raw: string, command: string): string[] {
  const echo = compact(command);
  const out: string[] = [];
  for (const piece of raw.replace(/\0/g, '').replace(/SEARCHING\.*/gi, '\n').split(/[\r\n]+/)) {
    const line = piece.trim();
    if (!line || compact(line) === echo || /^BUS INIT/i.test(line)) continue;
    out.push(line);
  }
  return out;
}

export function responseError(lines: string[]): ObdErrorCode | null {
  for (const line of lines) {
    const c = compact(line);
    for (const [pattern, code] of ERROR_PATTERNS) if (pattern.test(c)) return code;
  }
  return null;
}

/** Data bytes of each line that answers a mode 01 request for `pid` (one line per responding ECU). */
export function pidPayloads(lines: string[], pid: number): number[][] {
  const prefix = `41${hex2(pid)}`;
  const out: number[][] = [];
  for (const line of lines) {
    const c = compact(line);
    if (!c.startsWith(prefix) || c.length % 2 !== 0 || !/^[0-9A-F]+$/.test(c)) continue;
    const bytes: number[] = [];
    for (let i = prefix.length; i < c.length; i += 2) bytes.push(parseInt(c.slice(i, i + 2), 16));
    out.push(bytes);
  }
  return out;
}

/** Data bytes of a Mode 22 reply, from the first line that contains `responsePrefix` (e.g. '62B046'). */
export function mode22Payload(lines: string[], responsePrefix: string): number[] | null {
  const prefix = responsePrefix.toUpperCase();
  for (const line of lines) {
    const c = compact(line);
    const at = c.indexOf(prefix);
    if (at < 0) continue;
    const hex = c.slice(at + prefix.length);
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9A-F]+$/.test(hex)) continue;
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    return bytes;
  }
  return null;
}

/** PIDs flagged in a 4-byte "supported PIDs" bitmap; bit 7 of byte A is PID base+1. */
export function supportedFromBitmap(base: number, bytes: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) {
    if ((bytes[i >> 3] ?? 0) & (0x80 >> (i & 7))) out.push(base + i + 1);
  }
  return out;
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/**
 * The VIN in a mode 09 PID 02 reply (prefix '4902') or a UDS ReadDataByIdentifier F190 reply ('62F190').
 * Handles ISO-TP multi-frame output ('014', '0:4902…', '1:…') and legacy one-line-per-chunk replies.
 * null for all-FF fillers, ECU names and other non-VINs.
 */
export function parseVinReply(lines: string[], prefix: '4902' | '62F190'): string | null {
  const c = lines.map(compact).filter((l) => l && l !== 'OK');
  let hex = '';
  let total = Infinity;
  if (c.length > 0 && /^[0-9A-F]{3}$/.test(c[0])) {
    total = parseInt(c[0], 16);
    for (const line of c.slice(1)) {
      const m = line.match(/^[0-9A-F]:([0-9A-F]+)$/);
      if (m) hex += m[1];
    }
    hex = hex.slice(0, total * 2);
  } else if (prefix === '4902' && c.filter((l) => l.startsWith('4902')).length > 1) {
    // Legacy protocols: '49 02 0N' + four bytes per line.
    hex = `4902${c.filter((l) => l.startsWith('4902')).map((l) => l.slice(6)).join('')}`;
  } else {
    hex = c.join('');
  }
  let at = hex.indexOf(prefix);
  while (at > 0 && at % 2 !== 0) at = hex.indexOf(prefix, at + 1);
  if (at < 0) return null;
  let data = hex.slice(at + prefix.length);
  if (prefix === '4902' && c.length > 0 && /^[0-9A-F]{3}$/.test(c[0])) data = data.slice(2);
  let text = '';
  for (let i = 0; i + 1 < data.length; i += 2) {
    const b = parseInt(data.slice(i, i + 2), 16);
    if (b === 0x00 || b === 0xff) continue;
    text += String.fromCharCode(b);
  }
  text = text.toUpperCase().trim();
  const vin = text.length > 17 ? text.slice(-17) : text;
  return VIN_RE.test(vin) ? vin : null;
}

/** ECUs asked for the VIN over UDS when mode 09 has nothing; some answer only when addressed directly. */
const UDS_VIN_HEADERS = ['7E0', '7E2', '7E4'] as const;

export const decode = {
  speedKmh: (b: number[]) => b[0],
  evBatteryPct: (b: number[]) => (b[0] * 100) / 255,
  ambientC: (b: number[]) => b[0] - 40,
  moduleVoltage: (b: number[]) => (256 * b[0] + (b[1] ?? 0)) / 1000,
};

interface Pending {
  resolve: (raw: string) => void;
  reject: (err: ObdError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** ELM327 client: one command in flight, replies collected up to the '>' prompt. */
export class Elm327 {
  private buffer = '';
  private pending: Pending | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private searched = false;
  private readonly unsubscribe: () => void;
  private readonly timeoutMs: number;
  private readonly resetTimeoutMs: number;
  private readonly searchTimeoutMs: number;

  constructor(private readonly transport: ObdTransport, opts: Elm327Options = {}) {
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? Math.max(this.timeoutMs, 5000);
    this.searchTimeoutMs = opts.searchTimeoutMs ?? Math.max(this.timeoutMs, 10_000);
    this.unsubscribe = transport.onData((chunk) => this.onData(chunk));
  }

  /** Sends a command and resolves with its cleaned response lines; adapter error replies reject with ObdError. */
  send(command: string, timeoutMs = this.timeoutMs): Promise<string[]> {
    const run = this.tail.then(() => this.exec(command, timeoutMs));
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Resets the adapter and sets it up for plain, header-less replies. Resolves with its version string. */
  async init(): Promise<string> {
    let version = '';
    for (const command of INIT_COMMANDS) {
      try {
        const lines = await this.send(command, command === 'ATZ' ? this.resetTimeoutMs : this.timeoutMs);
        if (command === 'ATZ') version = lines.find((l) => /ELM|v\d/i.test(l)) ?? lines[0] ?? '';
      } catch (err) {
        if (!(err instanceof ObdError && err.code === 'unknown_command' && OPTIONAL_INIT.has(command))) throw err;
      }
    }
    this.searched = false;
    return version;
  }

  /** Mode 01 PIDs the car supports (union over all responding ECUs). */
  async supportedPids(): Promise<Set<number>> {
    const out = new Set<number>();
    for (const base of SUPPORTED_PID_QUERIES) {
      if (base > 0 && !out.has(base)) break;
      const payloads = await this.queryPid(base);
      if (payloads.length === 0) {
        if (base === 0) throw new ObdError('unable_to_connect');
        break;
      }
      for (const bytes of payloads) for (const pid of supportedFromBitmap(base, bytes)) out.add(pid);
    }
    return out;
  }

  /** Data bytes from the first ECU that answers, or null when the car has no data for it. */
  async readPid(pid: number): Promise<number[] | null> {
    const payloads = await this.queryPid(pid);
    return payloads[0] ?? null;
  }

  async readSpeedKmh(): Promise<number | null> {
    return this.readDecoded(PID.speed, 1, decode.speedKmh);
  }

  async readEvBatteryPct(): Promise<number | null> {
    return this.readDecoded(PID.evBatteryPct, 1, decode.evBatteryPct);
  }

  async readAmbientC(): Promise<number | null> {
    return this.readDecoded(PID.ambientTemp, 1, decode.ambientC);
  }

  async readModuleVoltage(): Promise<number | null> {
    return this.readDecoded(PID.moduleVoltage, 2, decode.moduleVoltage);
  }

  /**
   * A maker-specific BMS value read with Mode 22 at a particular ECU header, restoring the broadcast
   * header afterwards. Returns the data bytes after `responsePrefix`, or null when the car has nothing.
   * Used for battery % on EVs that skip the standard PID 0x5B (see socProfiles.ts).
   */
  async readMode22(header: string, request: string, responsePrefix: string): Promise<number[] | null> {
    try {
      await this.send(`ATSH${header}`);
      const lines = await this.send(request, Math.max(this.timeoutMs, 5000));
      return mode22Payload(lines, responsePrefix);
    } catch (err) {
      if (err instanceof ObdError && ['no_data', 'bad_response', 'unknown_command', 'timeout'].includes(err.code)) return null;
      throw err;
    } finally {
      await this.send('ATSH7DF').catch(() => undefined);
    }
  }

  /** Battery % via a maker's diagnostic identifier, decoded and range-gated by the profile; null if unavailable. */
  async readProfileSoc(p: { header: string; request: string; responsePrefix: string; decode: (b: number[]) => number | null }): Promise<number | null> {
    const bytes = await this.readMode22(p.header, p.request, p.responsePrefix);
    return bytes ? p.decode(bytes) : null;
  }

  /**
   * The car's VIN, or null when it won't share it. Many EVs answer neither request: India's OBD rules
   * are about emissions, so this is a bonus, never a requirement. Call after supportedPids().
   */
  async readVin(): Promise<string | null> {
    const ask = async (command: string, prefix: '4902' | '62F190') => {
      try {
        return parseVinReply(await this.send(command, Math.max(this.timeoutMs, 5000)), prefix);
      } catch (err) {
        if (err instanceof ObdError && ['no_data', 'bad_response', 'unknown_command'].includes(err.code)) return null;
        throw err;
      }
    };
    const vin = await ask('0902', '4902');
    if (vin) return vin;
    try {
      for (const header of UDS_VIN_HEADERS) {
        await this.send(`ATSH${header}`);
        const uds = await ask('22F190', '62F190');
        if (uds) return uds;
      }
      return null;
    } catch (err) {
      if (err instanceof ObdError && err.code === 'unknown_command') return null;
      throw err;
    } finally {
      await this.send('ATSH7DF').catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new ObdError('closed'));
      this.pending = null;
    }
    await this.transport.close();
  }

  private async readDecoded(pid: number, minBytes: number, fn: (b: number[]) => number): Promise<number | null> {
    const bytes = await this.readPid(pid);
    if (!bytes) return null;
    if (bytes.length < minBytes) throw new ObdError('bad_response');
    return fn(bytes);
  }

  private async queryPid(pid: number): Promise<number[][]> {
    const command = `01${hex2(pid)}`;
    const timeout = this.searched ? this.timeoutMs : this.searchTimeoutMs;
    let lines: string[];
    try {
      lines = await this.send(command, timeout);
    } catch (err) {
      if (err instanceof ObdError && err.code === 'no_data') return [];
      throw err;
    }
    this.searched = true;
    const payloads = pidPayloads(lines, pid);
    if (payloads.length === 0) throw new ObdError('bad_response');
    return payloads;
  }

  private async exec(command: string, timeoutMs: number): Promise<string[]> {
    if (this.closed) throw new ObdError('closed');
    const raw = await new Promise<string>((resolve, reject) => {
      this.buffer = '';
      const timer = setTimeout(() => {
        if (this.pending?.timer !== timer) return;
        this.pending = null;
        this.buffer = '';
        reject(new ObdError('timeout'));
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      this.transport.write(`${command}\r`).catch(() => {
        if (this.pending?.timer !== timer) return;
        clearTimeout(timer);
        this.pending = null;
        reject(new ObdError('closed'));
      });
    });
    const lines = cleanResponse(raw, command);
    const error = responseError(lines);
    if (error) throw new ObdError(error);
    return lines;
  }

  private onData(chunk: string): void {
    // Replies that arrive after a timeout, with nothing waiting, are dropped.
    if (!this.pending) return;
    this.buffer += chunk;
    const end = this.buffer.indexOf('>');
    if (end < 0) return;
    const raw = this.buffer.slice(0, end);
    this.buffer = '';
    const { resolve, timer } = this.pending;
    this.pending = null;
    clearTimeout(timer);
    resolve(raw);
  }
}

function compact(s: string): string {
  return s.replace(/\s+/g, '').toUpperCase();
}

function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}
