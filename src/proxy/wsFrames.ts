/**
 * WebSocket frames as they pass through the tunnel (RFC 6455 §5). The gateway still relays bytes: payloads are
 * neither decoded nor copied, only counted. What it reads is each frame's header, which is enough to know where frames
 * begin and end, how big a message is, and how many messages a client sends. That lets it enforce per-message limits
 * on what clients send, and end a connection with a proper close frame (sent at a frame boundary) instead of a reset.
 */
import { randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/** RFC 6455 §7.4.1 close codes the gateway sends. */
export const CLOSE = {
  goingAway: 1001,
  protocolError: 1002,
  policyViolation: 1008,
  messageTooBig: 1009,
} as const;

export interface MessageLimits {
  /** Largest message a client may send, in bytes of payload (summed over its frames). */
  maxMessageBytes?: number;
  /** Messages (and pings) a client may send: a token bucket per connection. */
  rate?: { perSecond: number; burst: number };
}

export type Violation = { kind: 'message_too_large' | 'message_rate' | 'protocol_error'; code: number; reason: string };

export interface FrameStreamOptions {
  /** Frames on this side come from a client, so they must be masked (and are the ones limits apply to). */
  fromClient: boolean;
  limits?: MessageLimits;
  /**
   * Called once, the moment a frame breaks a rule. No byte of that frame has been passed on: this direction ends with
   * a close frame giving the code instead.
   */
  onViolation?: (violation: Violation) => void;
  now?: () => number;
}

/** A close frame. Toward an upstream the gateway is the client, and RFC 6455 requires client frames to be masked. */
export function closeFrame(code: number, reason: string, masked: boolean): Buffer {
  const payload = Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason, 'utf8').subarray(0, 123)]);
  const head = Buffer.from([0x88, (masked ? 0x80 : 0) | payload.length]);
  if (!masked) return Buffer.concat([head, payload]);
  const key = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] = (body[i] as number) ^ (key[i % 4] as number);
  return Buffer.concat([head, key, body]);
}

const OPCODES = new Set([0, 1, 2, 8, 9, 10]);

export class FrameStream extends Transform {
  private readonly head = Buffer.alloc(14);
  private headLength = 0;
  /** Bytes the current header needs: 2 until the second byte says how many more there are. */
  private needed = 2;
  private payloadLeft = 0;
  /** Inside a fragmented message: data frames until FIN, then a new message. */
  private inMessage = false;
  private messageBytes = 0;
  private tokens: number;
  private refilledAt: number;
  private stopped = false;
  private pendingClose?: { code: number; reason: string };
  /** A close frame to send instead of the source's own (see replaceNextClose). */
  private replacement?: { code: number; reason: string };
  private readonly now: () => number;

  constructor(private readonly options: FrameStreamOptions) {
    super();
    this.tokens = options.limits?.rate?.burst ?? 0;
    this.now = options.now ?? (() => performance.now());
    this.refilledAt = this.now();
  }

  /** At a frame boundary: nothing of a frame has been passed on without the rest of it. */
  get atBoundary(): boolean {
    return this.headLength === 0 && this.payloadLeft === 0;
  }

  /**
   * End this direction with a close frame: at once if between frames, otherwise as soon as the frame in progress has
   * been passed on whole. Everything after it is discarded. (Frames from a client are going to an upstream, for which
   * the gateway is the client, so the close frame is masked; frames from an upstream go to a client unmasked.)
   */
  closeAtBoundary(code: number, reason: string): void {
    if (this.stopped) return;
    this.pendingClose = { code, reason };
    if (this.atBoundary) this.finishWithClose();
  }

  /**
   * End this direction with this close frame in place of the next one the source sends (or when the source ends):
   * whatever the source still has to say before its own close frame, such as replies to messages it was sent, is
   * passed on first.
   */
  replaceNextClose(code: number, reason: string): void {
    if (!this.stopped) this.replacement = { code, reason };
  }

  override _flush(done: TransformCallback): void {
    // The source ended without a close frame: send ours, if one is waiting and nothing is half sent.
    const close = this.pendingClose ?? this.replacement;
    if (close && !this.stopped && this.atBoundary) {
      this.stopped = true;
      this.push(closeFrame(close.code, close.reason, this.options.fromClient));
    }
    done();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    if (this.stopped) {
      done(); // after the close frame: discarded
      return;
    }
    const out: Buffer[] = [];
    let i = 0;
    while (i < chunk.length && !this.stopped) {
      if (this.payloadLeft > 0) {
        const n = Math.min(this.payloadLeft, chunk.length - i);
        out.push(chunk.subarray(i, i + n));
        i += n;
        this.payloadLeft -= n;
        if (this.payloadLeft === 0 && this.pendingClose) this.flushThenClose(out);
        continue;
      }
      const take = Math.min(this.needed - this.headLength, chunk.length - i);
      chunk.copy(this.head, this.headLength, i, i + take);
      this.headLength += take;
      i += take;
      if (this.headLength === 2 && this.needed === 2) {
        const second = this.head[1] as number;
        const short = second & 0x7f;
        this.needed = 2 + (short === 126 ? 2 : short === 127 ? 8 : 0) + (second & 0x80 ? 4 : 0);
      }
      if (this.headLength < this.needed) continue;

      if (this.replacement && ((this.head[0] as number) & 0x0f) === 8) {
        // The source's close frame: ours goes in its place, and that is the end of this direction.
        this.pendingClose = this.replacement;
        this.flushThenClose(out);
        break;
      }
      const violation = this.check();
      if (violation) {
        // Everything before the offending frame goes on; then a close frame saying why, and nothing more.
        this.pendingClose = { code: violation.code, reason: violation.reason };
        this.flushThenClose(out);
        this.options.onViolation?.(violation);
        break;
      }
      out.push(Buffer.from(this.head.subarray(0, this.headLength)));
      this.headLength = 0;
      this.needed = 2;
      if (this.payloadLeft === 0 && this.pendingClose) this.flushThenClose(out);
    }
    if (out.length > 0 && !this.stopped) this.push(Buffer.concat(out));
    done();
  }

  /** Pass on what this chunk has produced so far, then the close frame, and stop. */
  private flushThenClose(out: Buffer[]): void {
    if (out.length > 0) this.push(Buffer.concat(out));
    out.length = 0;
    this.finishWithClose();
  }

  private finishWithClose(): void {
    const close = this.pendingClose;
    if (!close || this.stopped) return;
    this.stopped = true;
    this.push(closeFrame(close.code, close.reason, this.options.fromClient));
    this.push(null);
  }

  /** The complete header in `this.head`: record the frame and decide whether it may pass. */
  private check(): Violation | undefined {
    const first = this.head[0] as number;
    const second = this.head[1] as number;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    const short = second & 0x7f;
    let length = short;
    if (short === 126) length = this.head.readUInt16BE(2);
    else if (short === 127) {
      const big = this.head.readBigUInt64BE(2);
      // The top bit must be clear (§5.2), and nothing near 2^53 bytes is a real frame.
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return protocol('frame length out of range');
      length = Number(big);
    }
    this.payloadLeft = length;
    if (!this.options.fromClient) return undefined; // the upstream's frames are relayed as they are

    if (!masked) return protocol('client frames must be masked');
    if (!OPCODES.has(opcode)) return protocol('unknown opcode');
    const limits = this.options.limits ?? {};
    if (opcode >= 8) {
      if (!fin || length > 125) return protocol('control frames must be whole and at most 125 bytes');
      if (opcode === 9 && !this.takeToken()) return rate();
      return undefined;
    }
    if (opcode === 0) {
      if (!this.inMessage) return protocol('continuation without a message');
      this.messageBytes += length;
    } else {
      if (this.inMessage) return protocol('a new message before the last one finished');
      if (!this.takeToken()) return rate();
      this.messageBytes = length;
    }
    this.inMessage = !fin;
    if (limits.maxMessageBytes !== undefined && this.messageBytes > limits.maxMessageBytes) {
      return { kind: 'message_too_large', code: CLOSE.messageTooBig, reason: 'message too big' };
    }
    return undefined;
  }

  /** One message (or ping) from the token bucket; true when there is no rate limit. */
  private takeToken(): boolean {
    const rate = this.options.limits?.rate;
    if (!rate) return true;
    const now = this.now();
    this.tokens = Math.min(rate.burst, this.tokens + ((now - this.refilledAt) / 1000) * rate.perSecond);
    this.refilledAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const protocol = (reason: string): Violation => ({ kind: 'protocol_error', code: CLOSE.protocolError, reason });
const rate = (): Violation => ({ kind: 'message_rate', code: CLOSE.policyViolation, reason: 'too many messages' });
