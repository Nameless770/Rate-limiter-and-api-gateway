/**
 * Limits on the messages a client sends over a proxied WebSocket (routes[].websocket.maxMessageBytes and
 * messageRate): enforced by the gateway, on real connections, with the upstream never seeing what was refused.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { capturingLogger, rawRequest, sleep, startGateway } from './helpers.js';
import { encodeFrame, OP, openWs, startWsUpstream, type WsSession } from './wsHelpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function setup(websocket: Record<string, unknown>, upstream: Parameters<typeof startWsUpstream>[0] = {}) {
  const up = await startWsUpstream(upstream);
  cleanups.push(up.close);
  const { logger, lines } = capturingLogger();
  const g = await startGateway(
    {
      upstreams: { chat: { url: up.url } },
      routes: [
        {
          id: 'chat',
          path: '/ws',
          upstream: 'chat',
          stripPrefix: false,
          websocket: { allowAnyOrigin: true, ...websocket },
        },
      ],
    },
    { logger },
  );
  cleanups.push(g.close);
  const connect = async (trailing?: Buffer): Promise<WsSession> => {
    const attempt = await openWs(g.base, { path: '/ws', trailing });
    expect(attempt.status).toBe(101);
    const ws = attempt.ws as WsSession;
    cleanups.push(() => ws.destroy());
    return ws;
  };
  const closedWith = async (ws: WsSession) => {
    for (;;) {
      const frame = await ws.next();
      if (frame.opcode === OP.close)
        return { code: frame.payload.readUInt16BE(0), reason: frame.payload.subarray(2).toString() };
    }
  };
  const loggedReason = async () => {
    for (let i = 0; i < 200; i++) {
      const line = lines.find((l) => l['msg'] === 'websocket closed');
      if (line) return line['reason'];
      await sleep(10);
    }
    return undefined;
  };
  return { up, g, connect, closedWith, loggedReason };
}

describe('websocket message limits', () => {
  it('relays messages up to the size limit, and closes with 1009 on one over it, which never reaches the upstream', async () => {
    const t = await setup({ maxMessageBytes: 8 });
    const ws = await t.connect();
    ws.send('12345678');
    expect(await ws.nextText()).toBe('12345678');
    ws.send('123456789');
    expect(await t.closedWith(ws)).toEqual({ code: 1009, reason: 'message too big' });
    expect(await ws.closesWithin(3_000)).toBe(true);
    expect(t.up.received).toEqual(['12345678']);
    expect(await t.loggedReason()).toBe('message_too_large');
    const metrics = (await rawRequest(t.g.adminBase, { path: '/_gateway/metrics' })).body;
    const closed = metrics
      .split('\n')
      .find((l) => l.startsWith('gateway_websocket_closed_total{') && l.includes('reason="message_too_large"'));
    expect(closed).toContain('route="chat"');
    expect(closed?.endsWith(' 1')).toBe(true);
  });

  it('limits the rate of messages on a connection, and closes with 1008', async () => {
    const t = await setup({ messageRate: { perSecond: 1, burst: 3 } });
    const ws = await t.connect();
    for (const m of ['a', 'b', 'c', 'd', 'e']) ws.send(m);
    const echoed: string[] = [];
    for (;;) {
      const frame = await ws.next();
      if (frame.opcode === OP.close) {
        expect(frame.payload.readUInt16BE(0)).toBe(1008);
        break;
      }
      echoed.push(frame.payload.toString());
    }
    expect(echoed).toEqual(['a', 'b', 'c']);
    expect(t.up.received).toEqual(['a', 'b', 'c']);
    expect(await t.loggedReason()).toBe('message_rate');
  });

  it("tells the client which limit it broke even when the upstream's own close says something else", async () => {
    // An ordinary server answers a close with 1000; the client must still learn it was cut off for its rate.
    const t = await setup({ messageRate: { perSecond: 1, burst: 1 } }, { closeCode: 1000 });
    const ws = await t.connect();
    ws.send('a');
    ws.send('b');
    const started = Date.now();
    expect(await t.closedWith(ws)).toEqual({ code: 1008, reason: 'too many messages' });
    expect(Date.now() - started).toBeLessThan(800); // in place of the upstream's close, not after a timeout
    expect(t.up.received).toEqual(['a']);
  });

  it('applies the limits to what a client sent right behind its handshake', async () => {
    const t = await setup({ maxMessageBytes: 4 });
    const ws = await t.connect(encodeFrame(OP.text, Buffer.from('far too long'), true));
    expect((await t.closedWith(ws)).code).toBe(1009);
    expect(t.up.received).toEqual([]);
  });

  it('closes with 1002 on a frame that breaks the protocol, such as an unmasked one', async () => {
    const t = await setup({});
    const ws = await t.connect();
    ws.socket.write(encodeFrame(OP.text, Buffer.from('not masked'), false));
    expect((await t.closedWith(ws)).code).toBe(1002);
    expect(await t.loggedReason()).toBe('protocol_error');
    expect(t.up.received).toEqual([]);
  });

  it("does not hold the upstream's messages to the client's limits", async () => {
    const t = await setup({ maxMessageBytes: 4, messageRate: { perSecond: 1, burst: 1 } });
    const ws = await t.connect();
    ws.send('hi');
    expect(await ws.nextText()).toBe('hi');
    for (let i = 0; i < 5; i++) t.up.broadcast('a long message from the upstream');
    for (let i = 0; i < 5; i++) expect(await ws.nextText()).toBe('a long message from the upstream');
  });

  it('has no message limits unless a route sets them', async () => {
    const t = await setup({});
    const ws = await t.connect();
    const big = 'x'.repeat(60_000);
    for (let i = 0; i < 20; i++) ws.send(i === 0 ? big : String(i));
    expect(await ws.nextText()).toBe(big);
    for (let i = 1; i < 20; i++) expect(await ws.nextText()).toBe(String(i));
  });
});
