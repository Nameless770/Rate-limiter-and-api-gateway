import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { acceptKey, checkUpstreamHandshake, originAllowed, validateHandshake } from '../src/proxy/websocket.js';

const KEY = 'dGhlIHNhbXBsZSBub25jZQ=='; // the example key from RFC 6455 §1.3

const request = (headers: Record<string, string>, method = 'GET'): IncomingMessage =>
  ({
    method,
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': KEY,
      'sec-websocket-version': '13',
      ...headers,
    },
  }) as unknown as IncomingMessage;

const refusal = (headers: Record<string, string>, method?: string) => {
  const check = validateHandshake(request(headers, method));
  if (check.ok) return expect.unreachable('handshake was accepted');
  return check;
};

describe('acceptKey', () => {
  it('matches the worked example in RFC 6455', () => {
    expect(acceptKey(KEY)).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('validateHandshake', () => {
  it('accepts the handshake a browser sends, and reports what was offered', () => {
    expect(validateHandshake(request({}))).toEqual({ ok: true, key: KEY, protocols: [], offersExtensions: false });
    expect(
      validateHandshake(
        request({ 'sec-websocket-protocol': 'chat, superchat', 'sec-websocket-extensions': 'permessage-deflate' }),
      ),
    ).toEqual({ ok: true, key: KEY, protocols: ['chat', 'superchat'], offersExtensions: true });
  });

  it('is not fooled by letter case or extra tokens in Connection', () => {
    expect(validateHandshake(request({ upgrade: 'WebSocket', connection: 'keep-alive, UPGRADE' })).ok).toBe(true);
  });

  it('accepts only GET', () => {
    expect(refusal({}, 'POST')).toMatchObject({ status: 405, headers: { allow: 'GET' } });
    expect(refusal({}, 'CONNECT')).toMatchObject({ status: 405 });
  });

  it('accepts only the websocket upgrade, and only on its own', () => {
    for (const upgrade of ['h2c', 'TLS/1.0', 'websocket, h2c', 'h2c, websocket', '', 'websocket2']) {
      expect(refusal({ upgrade }), upgrade).toMatchObject({ status: 400, code: 'bad_upgrade' });
    }
  });

  it('requires Connection to say Upgrade', () => {
    for (const connection of ['keep-alive', 'close', '', 'Upgraded']) {
      expect(refusal({ connection }), connection).toMatchObject({ status: 400, code: 'bad_upgrade' });
    }
  });

  it('refuses a handshake that carries a body', () => {
    expect(refusal({ 'content-length': '5' })).toMatchObject({ status: 400 });
    expect(refusal({ 'transfer-encoding': 'chunked' })).toMatchObject({ status: 400 });
    expect(validateHandshake(request({ 'content-length': '0' })).ok).toBe(true);
  });

  it('requires version 13 and tells the client so', () => {
    for (const version of ['8', '12', '14', '', '13, 13']) {
      expect(refusal({ 'sec-websocket-version': version }), version).toMatchObject({
        status: 426,
        headers: { 'sec-websocket-version': '13' },
      });
    }
  });

  it('requires a well-formed 16-byte key', () => {
    const bad = [
      '',
      'dGVzdA==',
      'dGhlIHNhbXBsZSBub25jZQ',
      `${KEY}A`,
      '!!!!!!!!!!!!!!!!!!!!!!==',
      ' dGhlIHNhbXBsZSBub25jZQ==',
    ];
    for (const key of bad) expect(refusal({ 'sec-websocket-key': key }), key).toMatchObject({ status: 400 });
  });

  it('refuses malformed subprotocol and extension lists', () => {
    expect(refusal({ 'sec-websocket-protocol': 'chat,,x' })).toMatchObject({ status: 400 });
    expect(refusal({ 'sec-websocket-protocol': 'bad protocol' })).toMatchObject({ status: 400 });
    expect(refusal({ 'sec-websocket-protocol': 'chat\r\nx: y' })).toMatchObject({ status: 400 });
    expect(refusal({ 'sec-websocket-extensions': 'a'.repeat(2_000) })).toMatchObject({ status: 400 });
    expect(refusal({ 'sec-websocket-extensions': 'permessage-deflate\u0001' })).toMatchObject({ status: 400 });
  });
});

describe('originAllowed', () => {
  const allowed = ['https://app.example.com', 'http://localhost:3000'];

  it('lets clients without an Origin through: they are not browsers', () => {
    expect(originAllowed(undefined, [], false)).toBe(true);
    expect(originAllowed(undefined, allowed, false)).toBe(true);
  });

  it('accepts exactly the listed origins, whatever the letter case', () => {
    expect(originAllowed('https://app.example.com', allowed, false)).toBe(true);
    expect(originAllowed('HTTPS://App.Example.COM', allowed, false)).toBe(true);
    expect(originAllowed('http://localhost:3000', allowed, false)).toBe(true);
  });

  it.each([
    'https://app.example.com.evil.example',
    'https://evil.example',
    'http://app.example.com',
    'https://app.example.com:8443',
    'https://app.example.com/',
    'https://app.example.com, https://evil.example',
    'null',
    '',
  ])('refuses %j', (origin) => {
    expect(originAllowed(origin, allowed, false)).toBe(false);
  });

  it('accepts anything when told to, and nothing from a browser when the list is empty', () => {
    expect(originAllowed('https://anywhere.example', [], true)).toBe(true);
    expect(originAllowed('null', [], true)).toBe(true);
    expect(originAllowed('https://app.example.com', [], false)).toBe(false);
  });
});

describe('checkUpstreamHandshake', () => {
  const client = { key: KEY, protocols: ['chat', 'superchat'], offersExtensions: false };
  const good = { upgrade: 'websocket', 'sec-websocket-accept': acceptKey(KEY) };

  it('accepts a correct answer and reports what the upstream chose', () => {
    expect(checkUpstreamHandshake(good, client)).toEqual({ ok: true, protocol: undefined, extensions: undefined });
    expect(checkUpstreamHandshake({ ...good, 'sec-websocket-protocol': 'chat' }, client)).toMatchObject({
      ok: true,
      protocol: 'chat',
    });
    expect(
      checkUpstreamHandshake(
        { ...good, 'sec-websocket-extensions': 'permessage-deflate' },
        { ...client, offersExtensions: true },
      ),
    ).toMatchObject({ ok: true, extensions: 'permessage-deflate' });
  });

  it('rejects an answer that is not an upgrade to websocket', () => {
    expect(checkUpstreamHandshake({ ...good, upgrade: 'h2c' }, client)).toMatchObject({ ok: false });
    expect(checkUpstreamHandshake({ 'sec-websocket-accept': good['sec-websocket-accept'] }, client)).toMatchObject({
      ok: false,
    });
  });

  it('rejects a missing or wrong accept key', () => {
    expect(checkUpstreamHandshake({ upgrade: 'websocket' }, client)).toMatchObject({ ok: false });
    expect(checkUpstreamHandshake({ ...good, 'sec-websocket-accept': acceptKey('another key') }, client)).toMatchObject(
      {
        ok: false,
      },
    );
  });

  it('rejects a subprotocol the client did not offer', () => {
    expect(checkUpstreamHandshake({ ...good, 'sec-websocket-protocol': 'admin' }, client)).toMatchObject({ ok: false });
    expect(checkUpstreamHandshake({ ...good, 'sec-websocket-protocol': 'chat, superchat' }, client)).toMatchObject({
      ok: false,
    });
  });

  it('rejects an extension the client did not offer', () => {
    expect(checkUpstreamHandshake({ ...good, 'sec-websocket-extensions': 'permessage-deflate' }, client)).toMatchObject(
      {
        ok: false,
      },
    );
  });

  it('rejects header values that could not be written safely into the 101', () => {
    const offering = { ...client, protocols: ['chat\r\nx: y'], offersExtensions: true };
    expect(checkUpstreamHandshake({ ...good, 'sec-websocket-protocol': 'chat\r\nx: y' }, offering)).toMatchObject({
      ok: false,
    });
    expect(checkUpstreamHandshake({ ...good, 'sec-websocket-extensions': 'a\u0000b' }, offering)).toMatchObject({
      ok: false,
    });
  });
});
