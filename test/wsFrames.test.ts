/**
 * The frame reader in the WebSocket tunnel, fed bytes directly: frames pass byte for byte however they are split,
 * and a client that breaks a rule gets a close frame in place of the offending frame.
 */
import { describe, expect, it } from 'vitest';
import { CLOSE, closeFrame, FrameStream, type MessageLimits, type Violation } from '../src/proxy/wsFrames.js';
import { encodeFrame, FrameReader, OP } from './wsHelpers.js';

/** Run bytes through a stream (split into the given chunk sizes) and collect what comes out. */
async function run(
  input: Buffer,
  opts: { fromClient?: boolean; limits?: MessageLimits; now?: () => number; chunk?: number } = {},
): Promise<{ out: Buffer; violations: Violation[]; ended: boolean }> {
  const violations: Violation[] = [];
  const stream = new FrameStream({
    fromClient: opts.fromClient ?? true,
    limits: opts.limits,
    now: opts.now,
    onViolation: (v) => violations.push(v),
  });
  const out: Buffer[] = [];
  let ended = false;
  stream.on('data', (c: Buffer) => out.push(c));
  stream.on('end', () => {
    ended = true;
  });
  const size = opts.chunk ?? input.length;
  for (let i = 0; i < input.length; i += size) stream.write(input.subarray(i, i + size));
  await new Promise((resolve) => setImmediate(resolve));
  return { out: Buffer.concat(out), violations, ended };
}

const text = (s: string, mask = true) => encodeFrame(OP.text, Buffer.from(s), mask);
/** A frame with an explicit FIN bit (encodeFrame always sets it). */
const fragment = (opcode: number, payload: Buffer, fin: boolean) => {
  const frame = encodeFrame(opcode, payload, true);
  frame[0] = (fin ? 0x80 : 0) | opcode;
  return frame;
};
const frames = (bytes: Buffer) => new FrameReader().push(bytes);

describe('relaying frames', () => {
  it('passes frames on byte for byte, however the bytes are split', async () => {
    const input = Buffer.concat([
      text('hello'),
      encodeFrame(OP.binary, Buffer.alloc(300, 7), true), // a 16-bit length
      encodeFrame(OP.ping, Buffer.from('p'), true),
      fragment(OP.text, Buffer.from('two '), false),
      fragment(OP.continuation, Buffer.from('parts'), true),
    ]);
    for (const chunk of [input.length, 1, 3, 7]) {
      const { out, violations } = await run(input, { chunk });
      expect(out.equals(input), `chunks of ${chunk}`).toBe(true);
      expect(violations).toEqual([]);
    }
  });

  it("passes an upstream's unmasked frames as they are", async () => {
    const input = Buffer.concat([text('a', false), text('b', false)]);
    expect((await run(input, { fromClient: false })).out.equals(input)).toBe(true);
  });
});

describe('limits on what a client sends', () => {
  it('stops a message over the size limit before any of it is passed on, and sends close 1009 instead', async () => {
    const ok = text('12345');
    const { out, violations, ended } = await run(Buffer.concat([ok, text('123456'), text('after')]), {
      limits: { maxMessageBytes: 5 },
    });
    expect(violations.map((v) => [v.kind, v.code])).toEqual([['message_too_large', CLOSE.messageTooBig]]);
    const passed = frames(out);
    expect(passed.map((f) => f.opcode)).toEqual([OP.text, OP.close]);
    expect(passed[0]?.payload.toString()).toBe('12345');
    expect(passed[1]?.payload.readUInt16BE(0)).toBe(1009);
    expect(ended).toBe(true);
  });

  it('counts every frame of a fragmented message toward its size', async () => {
    const { violations, out } = await run(
      Buffer.concat([
        fragment(OP.text, Buffer.from('abc'), false),
        fragment(OP.continuation, Buffer.from('def'), true),
      ]),
      { limits: { maxMessageBytes: 5 } },
    );
    expect(violations.map((v) => v.kind)).toEqual(['message_too_large']);
    expect(frames(out).map((f) => f.opcode)).toEqual([OP.text, OP.close]); // the first fragment went; the rest did not
  });

  it('limits the rate of messages and pings, and refills over time', async () => {
    let now = 0;
    const limits = { rate: { perSecond: 2, burst: 2 } };
    const burst = await run(Buffer.concat([text('1'), text('2'), text('3')]), { limits, now: () => now });
    expect(burst.violations.map((v) => [v.kind, v.code])).toEqual([['message_rate', CLOSE.policyViolation]]);
    expect(frames(burst.out).map((f) => f.opcode)).toEqual([OP.text, OP.text, OP.close]);

    // A connection that has been quiet for a long time still has only its burst to spend, not everything it saved.
    const afterQuiet: Violation[] = [];
    const saved = new FrameStream({ fromClient: true, limits, now: () => now, onViolation: (v) => afterQuiet.push(v) });
    saved.resume();
    now += 60_000;
    for (const m of ['1', '2', '3']) saved.write(text(m));
    await new Promise((resolve) => setImmediate(resolve));
    expect(afterQuiet.map((v) => v.kind)).toEqual(['message_rate']);

    const pings = await run(Buffer.concat([encodeFrame(OP.ping, Buffer.alloc(0), true), text('1'), text('2')]), {
      limits,
      now: () => now,
    });
    expect(pings.violations.map((v) => v.kind)).toEqual(['message_rate']);

    // Paced at the limit, nothing is refused. A pong (an answer to the upstream's ping) costs nothing, and the
    // continuation frames of a message are part of a message already paid for.
    const refused: Violation[] = [];
    const stream = new FrameStream({ fromClient: true, limits, now: () => now, onViolation: (v) => refused.push(v) });
    stream.resume();
    for (let i = 0; i < 10; i++) {
      now += 500;
      stream.write(text(String(i)));
      stream.write(encodeFrame(OP.pong, Buffer.alloc(0), true));
    }
    stream.write(fragment(OP.text, Buffer.from('a'), false));
    for (let i = 0; i < 5; i++) stream.write(fragment(OP.continuation, Buffer.from('b'), i === 4));
    await new Promise((resolve) => setImmediate(resolve));
    expect(refused).toEqual([]);
  });

  it('refuses frames that break the protocol: unmasked, unknown, oversized control, stray continuation', async () => {
    const cases: Array<[string, Buffer]> = [
      ['unmasked', text('x', false)],
      ['unknown opcode', encodeFrame(0x3, Buffer.from('x'), true)],
      ['ping over 125 bytes', encodeFrame(OP.ping, Buffer.alloc(126), true)],
      ['fragmented ping', fragment(OP.ping, Buffer.from('x'), false)],
      ['continuation without a message', fragment(OP.continuation, Buffer.from('x'), true)],
      ['a new message inside another', Buffer.concat([fragment(OP.text, Buffer.from('a'), false), text('b')])],
    ];
    for (const [name, bytes] of cases) {
      const { violations, out } = await run(bytes);
      expect(
        violations.map((v) => [v.kind, v.code]),
        name,
      ).toEqual([['protocol_error', CLOSE.protocolError]]);
      expect(frames(out).at(-1)?.opcode, name).toBe(OP.close);
    }
  });

  it('refuses a 64-bit length with the top bit set', async () => {
    const head = Buffer.from([0x82, 0x80 | 127, 0x80, 0, 0, 0, 0, 0, 0, 1, 1, 2, 3, 4]);
    expect((await run(head)).violations.map((v) => v.reason)).toEqual(['frame length out of range']);
  });
});

describe('closing at a frame boundary', () => {
  it('waits for the frame in progress, then sends the close frame and nothing after it', async () => {
    const stream = new FrameStream({ fromClient: false });
    const out: Buffer[] = [];
    stream.on('data', (c: Buffer) => out.push(c));
    const big = encodeFrame(OP.binary, Buffer.alloc(1000, 1), false);
    stream.write(big.subarray(0, 400)); // mid-frame
    stream.closeAtBoundary(1001, 'going away');
    stream.write(Buffer.concat([big.subarray(400), text('later', false)]));
    await new Promise((resolve) => setImmediate(resolve));
    const passed = frames(Buffer.concat(out));
    expect(passed.map((f) => f.opcode)).toEqual([OP.binary, OP.close]);
    expect(passed[0]?.payload.length).toBe(1000);
    expect(passed[1]?.payload.readUInt16BE(0)).toBe(1001);
  });

  it("passes on what the source still has to say, then sends its close frame in place of the source's", async () => {
    const stream = new FrameStream({ fromClient: false });
    const out: Buffer[] = [];
    stream.on('data', (c: Buffer) => out.push(c));
    stream.replaceNextClose(1008, 'too many messages');
    stream.write(
      Buffer.concat([
        text('reply 1', false),
        text('reply 2', false),
        encodeFrame(OP.close, Buffer.from([0x03, 0xe8]), false), // the source's own: 1000
        text('after the close', false),
      ]),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const passed = frames(Buffer.concat(out));
    expect(passed.map((f) => f.opcode)).toEqual([OP.text, OP.text, OP.close]);
    expect(passed[2]?.payload.readUInt16BE(0)).toBe(1008);
  });

  it('sends the waiting close frame when the source ends without one', async () => {
    const stream = new FrameStream({ fromClient: false });
    const out: Buffer[] = [];
    stream.on('data', (c: Buffer) => out.push(c));
    stream.replaceNextClose(1009, 'message too big');
    stream.end(text('last', false));
    await new Promise((resolve) => stream.once('end', resolve));
    expect(
      frames(Buffer.concat(out)).map((f) => [f.opcode, f.opcode === OP.close ? f.payload.readUInt16BE(0) : 0]),
    ).toEqual([
      [OP.text, 0],
      [OP.close, 1009],
    ]);
  });

  it('masks a close frame going to an upstream, and not one going to a client', () => {
    expect(((closeFrame(1000, 'bye', true)[1] as number) & 0x80) !== 0).toBe(true);
    expect(((closeFrame(1000, 'bye', false)[1] as number) & 0x80) !== 0).toBe(false);
    const [frame] = frames(closeFrame(1009, 'message too big', true));
    expect(frame?.payload.readUInt16BE(0)).toBe(1009);
    expect(frame?.payload.subarray(2).toString()).toBe('message too big');
  });
});
