import { createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bearerToken,
  hasDuplicateMembers,
  type JwtIssuer,
  type JwtIssuerSource,
  JwtKeyError,
  JwtVerifier,
  loadIssuer,
  MAX_TOKEN_BYTES,
} from '../src/auth/jwt.js';
import { signJwt, tamper, testKeys } from './jwtHelpers.js';

const keys = testKeys();
const NOW = 1_700_000_000_000;
const nowSec = NOW / 1000;
const noFile = (path: string): string => {
  throw new Error(`unexpected file read: ${path}`);
};

const hs = (extra: Partial<JwtIssuerSource> = {}): JwtIssuer =>
  loadIssuer({ name: 'hs', alg: 'HS256', secret: keys.hmacSecret, leewaySeconds: 0, ...extra }, noFile);
const rs = (extra: Partial<JwtIssuerSource> = {}): JwtIssuer =>
  loadIssuer({ name: 'rs', alg: 'RS256', publicKey: keys.rsa.publicPem, leewaySeconds: 0, ...extra }, noFile);
const es = (extra: Partial<JwtIssuerSource> = {}): JwtIssuer =>
  loadIssuer({ name: 'es', alg: 'ES256', publicKey: keys.ec.publicPem, leewaySeconds: 0, ...extra }, noFile);

const verifier = (...issuers: JwtIssuer[]) => new JwtVerifier(issuers, () => NOW);
const claims = (extra: Record<string, unknown> = {}) => ({ sub: 'alice', exp: nowSec + 600, ...extra });
const hsToken = (payload: Record<string, unknown> = claims(), header?: Record<string, unknown>) =>
  signJwt({ alg: 'HS256', key: keys.hmacSecret, payload, header });
const rsToken = (payload: Record<string, unknown> = claims(), header?: Record<string, unknown>) =>
  signJwt({ alg: 'RS256', key: keys.rsa.privateKey, payload, header });
const esToken = (payload: Record<string, unknown> = claims(), header?: Record<string, unknown>) =>
  signJwt({ alg: 'ES256', key: keys.ec.privateKey, payload, header });

const reason = (v: JwtVerifier, token: string) => {
  const r = v.verify(token);
  return r.ok ? 'ok' : r.reason;
};

describe('valid tokens', () => {
  it.each([
    ['HS256', hs, hsToken],
    ['RS256', rs, rsToken],
    ['ES256', es, esToken],
  ] as const)('%s verifies and yields the subject', (_name, issuer, token) => {
    const r = verifier(issuer()).verify(token());
    expect(r.ok && r.subject).toBe('alice');
    expect(r.ok && r.issuer.name).toBe(issuer().name);
  });
});

describe('the algorithm comes from configuration, never from the token', () => {
  it('rejects alg "none" in every spelling, with or without a signature', () => {
    const v = verifier(hs(), rs(), es());
    for (const alg of ['none', 'None', 'NONE', 'nOnE', '']) {
      const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(claims())).toString('base64url');
      expect(reason(v, `${header}.${payload}.`), `alg ${JSON.stringify(alg)} unsigned`).not.toBe('ok');
      expect(reason(v, `${header}.${payload}.AAAA`), `alg ${JSON.stringify(alg)} junk signature`).not.toBe('ok');
    }
  });

  it('refuses the RS256-public-key-as-HMAC-secret confusion attack', () => {
    // The attacker knows the (public) RSA key and signs an HS256 token using its PEM text as the secret. A verifier
    // that picks the algorithm from the token would treat the RSA public key as an HMAC key and accept this.
    const forged = signJwt({ alg: 'HS256', key: keys.rsa.publicPem, payload: claims({ sub: 'admin' }) });
    expect(reason(verifier(rs()), forged)).toBe('unsupported_alg');
  });

  it('refuses a token claiming a different algorithm than the key was provisioned for', () => {
    expect(reason(verifier(rs()), hsToken())).toBe('unsupported_alg');
    expect(reason(verifier(hs()), rsToken())).toBe('unsupported_alg');
    expect(reason(verifier(es()), rsToken())).toBe('unsupported_alg');
    // A genuine RS256 signature under a header that says ES256 is not an ES256 token either.
    expect(
      reason(
        verifier(es()),
        signJwt({ alg: 'RS256', key: keys.rsa.privateKey, payload: claims(), header: { alg: 'ES256' } }),
      ),
    ).toBe('bad_signature');
  });

  it('is case-sensitive about algorithm names', () => {
    expect(
      reason(
        verifier(hs()),
        signJwt({ alg: 'HS256', key: keys.hmacSecret, payload: claims(), header: { alg: 'hs256' } }),
      ),
    ).toBe('unsupported_alg');
  });

  it('rejects an ES256 signature in DER form: a different encoding of the same math is not a JWS', () => {
    const der = signJwt({ alg: 'ES256', key: keys.ec.privateKey, payload: claims(), derSignature: true });
    expect(reason(verifier(es()), der)).toBe('bad_signature');
  });
});

describe('signatures', () => {
  it('rejects a signature from the wrong key, for every algorithm', () => {
    expect(reason(verifier(hs()), signJwt({ alg: 'HS256', key: `${keys.hmacSecret}-other`, payload: claims() }))).toBe(
      'bad_signature',
    );
    expect(reason(verifier(rs()), signJwt({ alg: 'RS256', key: keys.rsa2.privateKey, payload: claims() }))).toBe(
      'bad_signature',
    );
    expect(reason(verifier(es()), signJwt({ alg: 'ES256', key: keys.ec2.privateKey, payload: claims() }))).toBe(
      'bad_signature',
    );
  });

  it('rejects any tampering with the payload or header after signing', () => {
    for (const [issuer, token] of [
      [hs(), hsToken()],
      [rs(), rsToken()],
      [es(), esToken()],
    ] as const) {
      const v = verifier(issuer);
      expect(
        reason(
          v,
          tamper(token, 1, (p) => (p['sub'] = 'admin')),
        ),
      ).toBe('bad_signature');
      expect(
        reason(
          v,
          tamper(token, 1, (p) => (p['exp'] = nowSec + 99_999_999)),
        ),
      ).toBe('bad_signature');
      expect(
        reason(
          v,
          tamper(token, 0, (h) => (h['typ'] = 'something-else')),
        ),
      ).toBe('bad_signature');
    }
  });

  it('rejects a truncated, extended or empty signature', () => {
    const token = hsToken();
    const v = verifier(hs());
    expect(reason(v, token.slice(0, -4))).toBe('bad_signature');
    expect(reason(v, `${token}AAAA`)).toBe('bad_signature');
    expect(reason(v, `${token.split('.').slice(0, 2).join('.')}.`)).toBe('malformed');
  });

  it('compares HMACs on the full digest', () => {
    // A signature equal to the real one except for its last byte must fail (and not by length alone).
    const input = hsToken().split('.').slice(0, 2).join('.');
    const real = createHmac('sha256', keys.hmacSecret).update(input).digest();
    const almost = Buffer.from(real);
    almost[almost.length - 1] = (almost[almost.length - 1] as number) ^ 1;
    expect(reason(verifier(hs()), `${input}.${almost.toString('base64url')}`)).toBe('bad_signature');
    expect(reason(verifier(hs()), `${input}.${real.toString('base64url')}`)).toBe('ok');
  });
});

describe('claims', () => {
  it('requires exp, and accepts it only as a number', () => {
    const v = verifier(hs());
    expect(reason(v, hsToken({ sub: 'alice' }))).toBe('missing_claim');
    expect(reason(v, hsToken({ sub: 'alice', exp: String(nowSec + 600) }))).toBe('malformed');
    expect(reason(v, hsToken({ sub: 'alice', exp: null }))).toBe('malformed');
    expect(reason(v, hsToken({ sub: 'alice', exp: [nowSec + 600] }))).toBe('malformed');
    expect(reason(v, hsToken({ sub: 'alice', exp: true }))).toBe('malformed');
  });

  it('rejects an expired token at, and not before, the expiry instant', () => {
    const v = verifier(hs());
    expect(reason(v, hsToken(claims({ exp: nowSec + 1 })))).toBe('ok');
    expect(reason(v, hsToken(claims({ exp: nowSec })))).toBe('expired'); // "now" must be *before* exp
    expect(reason(v, hsToken(claims({ exp: nowSec - 1 })))).toBe('expired');
  });

  it('applies the configured leeway to exp, nbf and iat symmetrically', () => {
    const v = verifier(hs({ leewaySeconds: 30 }));
    expect(reason(v, hsToken(claims({ exp: nowSec - 29 })))).toBe('ok');
    expect(reason(v, hsToken(claims({ exp: nowSec - 30 })))).toBe('expired');
    expect(reason(v, hsToken(claims({ nbf: nowSec + 30 })))).toBe('ok');
    expect(reason(v, hsToken(claims({ nbf: nowSec + 31 })))).toBe('not_yet_valid');
    expect(reason(v, hsToken(claims({ iat: nowSec + 30 })))).toBe('ok');
    expect(reason(v, hsToken(claims({ iat: nowSec + 31 })))).toBe('not_yet_valid');
  });

  it('rejects non-numeric nbf and iat', () => {
    const v = verifier(hs());
    expect(reason(v, hsToken(claims({ nbf: 'soon' })))).toBe('malformed');
    expect(reason(v, hsToken(claims({ iat: '0' })))).toBe('malformed');
  });

  it('enforces a maximum lifetime, from iat when present and from now when not', () => {
    const v = verifier(hs({ maxLifetimeSeconds: 3600 }));
    expect(reason(v, hsToken(claims({ iat: nowSec - 10, exp: nowSec - 10 + 3600 })))).toBe('ok');
    expect(reason(v, hsToken(claims({ iat: nowSec - 10, exp: nowSec - 10 + 3601 })))).toBe('too_long_lived');
    expect(reason(v, hsToken(claims({ exp: nowSec + 3600 })))).toBe('ok');
    expect(reason(v, hsToken(claims({ exp: nowSec + 3601 })))).toBe('too_long_lived');
  });

  it('enforces the issuer, whether the claim is wrong, missing or the wrong type', () => {
    const v = verifier(hs({ issuer: 'https://idp.example' }));
    expect(reason(v, hsToken(claims({ iss: 'https://idp.example' })))).toBe('ok');
    expect(reason(v, hsToken(claims({ iss: 'https://evil.example' })))).toBe('bad_issuer');
    expect(reason(v, hsToken(claims()))).toBe('bad_issuer');
    expect(reason(v, hsToken(claims({ iss: ['https://idp.example'] })))).toBe('bad_issuer');
  });

  it('enforces the audience, as a string or as a member of an array', () => {
    const v = verifier(hs({ audience: 'gateway' }));
    expect(reason(v, hsToken(claims({ aud: 'gateway' })))).toBe('ok');
    expect(reason(v, hsToken(claims({ aud: ['other', 'gateway'] })))).toBe('ok');
    expect(reason(v, hsToken(claims({ aud: 'other' })))).toBe('bad_audience');
    expect(reason(v, hsToken(claims({ aud: ['other'] })))).toBe('bad_audience');
    expect(reason(v, hsToken(claims()))).toBe('bad_audience');
    expect(reason(v, hsToken(claims({ aud: { gateway: true } })))).toBe('bad_audience');
    expect(reason(v, hsToken(claims({ aud: 'gateway-evil' })))).toBe('bad_audience'); // exact match, not prefix
  });

  it('does not check the audience when none is configured', () => {
    expect(reason(verifier(hs()), hsToken(claims({ aud: 'anything' })))).toBe('ok');
  });

  it('requires a usable subject', () => {
    const v = verifier(hs());
    for (const sub of [undefined, '', 123, null, ['a'], 'x'.repeat(257)]) {
      expect(reason(v, hsToken({ exp: nowSec + 600, sub })), JSON.stringify(sub)?.slice(0, 20)).toBe('missing_claim');
    }
    expect(reason(v, hsToken({ exp: nowSec + 600, sub: 'x'.repeat(256) }))).toBe('ok');
  });

  it('checks claims only after the signature, so an unsigned token learns nothing about them', () => {
    const forged = signJwt({
      alg: 'HS256',
      key: 'wrong-wrong-wrong-wrong-wrong-wrong!!',
      payload: { sub: 'a', exp: 1 },
    });
    expect(reason(verifier(hs()), forged)).toBe('bad_signature'); // not "expired"
  });
});

describe('structure', () => {
  const v = verifier(hs());

  it('rejects tokens that are not three base64url segments', () => {
    for (const token of [
      '',
      'a',
      'a.b',
      'a.b.c.d',
      '..',
      'a..c',
      '.b.c',
      'a.b.',
      'a b.c.d',
      'a.b.c==',
      'é.é.é',
      'a.b.c\n',
    ]) {
      expect(reason(v, token), JSON.stringify(token)).toBe('malformed');
    }
  });

  it('rejects a header or payload that is not a JSON object', () => {
    const enc = (s: string) => Buffer.from(s).toString('base64url');
    for (const bad of ['[]', '"str"', '42', 'null', 'true', '{', '{"a":}', '']) {
      expect(reason(v, `${enc(bad)}.${enc(JSON.stringify(claims()))}.AAAA`), `header ${bad}`).toBe('malformed');
      expect(reason(v, `${enc('{"alg":"HS256"}')}.${enc(bad)}.AAAA`), `payload ${bad}`).toBe('malformed');
    }
  });

  it('rejects oversized tokens before doing any work on them', () => {
    expect(reason(v, 'a'.repeat(MAX_TOKEN_BYTES + 1))).toBe('too_large');
    expect(reason(v, hsToken(claims({ pad: 'x'.repeat(MAX_TOKEN_BYTES) })))).toBe('too_large');
  });

  it('rejects critical header extensions it does not implement, and unencoded payloads', () => {
    expect(reason(v, hsToken(claims(), { crit: ['exp'] }))).toBe('malformed');
    expect(reason(v, hsToken(claims(), { crit: [] }))).toBe('malformed');
    expect(reason(v, hsToken(claims(), { b64: false, crit: ['b64'] }))).toBe('malformed');
  });

  it('rejects duplicate member names, which two parsers could read differently', () => {
    const secret = keys.hmacSecret;
    const dupSub = signJwt({
      alg: 'HS256',
      key: secret,
      payloadJson: `{"sub":"alice","sub":"admin","exp":${nowSec + 600}}`,
    });
    const dupExp = signJwt({ alg: 'HS256', key: secret, payloadJson: `{"sub":"alice","exp":1,"exp":${nowSec + 600}}` });
    const dupAlg = signJwt({
      alg: 'HS256',
      key: secret,
      headerJson: '{"alg":"HS256","alg":"none"}',
      payload: claims(),
    });
    const escaped = signJwt({
      alg: 'HS256',
      key: secret,
      payloadJson: `{"su\\u0062":"alice","sub":"admin","exp":${nowSec + 600}}`,
    });
    for (const [label, token] of [
      ['sub', dupSub],
      ['exp', dupExp],
      ['alg', dupAlg],
      ['escaped sub', escaped],
    ] as const) {
      expect(reason(v, token), label).toBe('malformed');
    }
  });

  it('treats a repeated name inside a nested object as acceptable: only top-level claims are read', () => {
    const token = signJwt({
      alg: 'HS256',
      key: keys.hmacSecret,
      payloadJson: `{"sub":"alice","exp":${nowSec + 600},"meta":{"x":1},"other":{"x":2}}`,
    });
    expect(reason(v, token)).toBe('ok');
  });
});

describe('hasDuplicateMembers', () => {
  it.each([
    ['{"a":1,"a":2}', true],
    ['{"a":1,"b":2,"a":3}', true],
    ['{ "a" : 1 , "a" : 2 }', true],
    ['{"a":1,"\\u0061":2}', true],
    ['{"a":1,"b":2}', false],
    ['{}', false],
    ['{"a":{"x":1},"b":{"x":2}}', false],
    ['{"a":"}{\\"","b":1}', false],
    ['{"a":"a","b":"a"}', false],
    ['{"a":[1,{"a":2}],"b":1}', false],
  ])('%s -> %s', (json, expected) => {
    expect(hasDuplicateMembers(json)).toBe(expected);
  });
});

describe('key selection and rotation', () => {
  it('selects keys by kid, and a token for one kid is not checked against another', () => {
    const v = verifier(
      hs({ name: 'old', kid: 'k1', secret: 'old-old-old-old-old-old-old-old-old-old!' }),
      hs({ name: 'new', kid: 'k2' }),
    );
    const newer = hsToken(claims(), { kid: 'k2' });
    const r = v.verify(newer);
    expect(r.ok && r.issuer.name).toBe('new');
    expect(reason(v, hsToken(claims(), { kid: 'k3' }))).toBe('unknown_key');
    expect(reason(v, hsToken(claims()))).toBe('unknown_key'); // both keys demand a kid
    // k2's secret under k1's kid: k1's key is the only candidate, and it does not verify.
    expect(reason(v, hsToken(claims(), { kid: 'k1' }))).toBe('bad_signature');
  });

  it('tries every key configured for the same issuer, so rotation overlap works', () => {
    const v = verifier(
      rs({ name: 'a' }),
      loadIssuer({ name: 'b', alg: 'RS256', publicKey: keys.rsa2.publicPem, leewaySeconds: 0 }, noFile),
    );
    const fromSecond = signJwt({ alg: 'RS256', key: keys.rsa2.privateKey, payload: claims() });
    const r = v.verify(fromSecond);
    expect(r.ok && r.issuer.name).toBe('b');
    expect(reason(v, rsToken())).toBe('ok');
  });

  it('matches an issuer only for its own iss claim', () => {
    const v = verifier(
      hs({ name: 'one', issuer: 'https://one.example' }),
      hs({ name: 'two', issuer: 'https://two.example', secret: 'two-two-two-two-two-two-two-two-two!!' }),
    );
    const r = v.verify(hsToken(claims({ iss: 'https://one.example' })));
    expect(r.ok && r.issuer.name).toBe('one');
    expect(reason(v, hsToken(claims({ iss: 'https://three.example' })))).toBe('bad_issuer');
  });

  it('does not let one issuer vouch for a token naming another', () => {
    // Signed with `one`'s secret but claiming to be from `two`: only `two`'s key may verify it, and it does not.
    const v = verifier(
      hs({ name: 'one', issuer: 'https://one.example' }),
      hs({ name: 'two', issuer: 'https://two.example', secret: 'two-two-two-two-two-two-two-two-two!!' }),
    );
    expect(reason(v, hsToken(claims({ iss: 'https://two.example' })))).toBe('bad_signature');
  });
});

describe('loading keys', () => {
  const load = (source: Partial<JwtIssuerSource>, readFile = noFile) =>
    loadIssuer({ name: 'x', alg: 'HS256', leewaySeconds: 0, ...source }, readFile);

  it('refuses short HMAC secrets', () => {
    expect(() => load({ secret: 'too-short' })).toThrow(/at least 32 bytes/);
    expect(() => load({ secret: 'x'.repeat(31) })).toThrow(JwtKeyError);
    expect(load({ secret: 'x'.repeat(32) }).secret?.length).toBe(32);
  });

  it('refuses RSA keys under 2048 bits', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({
      type: 'spki',
      format: 'pem',
    }) as string;
    expect(() => load({ alg: 'RS256', publicKey: weak })).toThrow(/1024 bits; at least 2048/);
  });

  it('refuses keys of the wrong type for the algorithm', () => {
    expect(() => load({ alg: 'RS256', publicKey: keys.ec.publicPem })).toThrow(/RSA key/);
    expect(() => load({ alg: 'ES256', publicKey: keys.rsa.publicPem })).toThrow(/P-256/);
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({
      type: 'spki',
      format: 'pem',
    }) as string;
    expect(() => load({ alg: 'ES256', publicKey: p384 })).toThrow(/P-256/);
    const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string;
    expect(() => load({ alg: 'ES256', publicKey: ed })).toThrow(/P-256/);
  });

  it('refuses mixing key kinds', () => {
    expect(() => load({ alg: 'HS256', secret: 'x'.repeat(32), publicKey: keys.rsa.publicPem })).toThrow(
      /not a public key/,
    );
    expect(() => load({ alg: 'RS256', secret: 'x'.repeat(32), publicKey: keys.rsa.publicPem })).toThrow(
      /not a "secret"/,
    );
    expect(() => load({ alg: 'RS256' })).toThrow(/exactly one of/);
    expect(() => load({ alg: 'RS256', publicKey: keys.rsa.publicPem, publicKeyFile: 'k.pem' })).toThrow(
      /exactly one of/,
    );
  });

  it('reads a key file, and reports a missing or unparseable one without leaking the contents', () => {
    expect(load({ alg: 'RS256', publicKeyFile: 'k.pem' }, () => keys.rsa.publicPem).publicKey).toBeDefined();
    expect(() =>
      load({ alg: 'RS256', publicKeyFile: 'missing.pem' }, () => {
        throw new Error('ENOENT');
      }),
    ).toThrow(/cannot read "missing.pem"/);
    expect(() => load({ alg: 'RS256', publicKey: 'definitely-not-pem-SECRET-CONTENT' })).toThrow(/not a valid PEM/);
    try {
      load({ alg: 'RS256', publicKey: 'definitely-not-pem-SECRET-CONTENT' });
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRET-CONTENT');
    }
  });

  it('refuses a private key where a public key belongs? it only ever uses the public half', () => {
    const privatePem = keys.rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const issuer = load({ alg: 'RS256', publicKey: privatePem });
    // createPublicKey derives the public key from a private one; verification still needs only that half.
    expect(issuer.publicKey?.type).toBe('public');
  });
});

describe('bearerToken', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc.def.ghi', 'abc.def.ghi'],
    ['BEARER abc', 'abc'],
    ['Bearer a-b_c.d~e+f/g=', 'a-b_c.d~e+f/g='],
  ])('extracts from %j', (header, token) => {
    expect(bearerToken(header)).toBe(token);
  });

  it.each([
    undefined,
    '',
    'Basic dXNlcjpwYXNz',
    'Bearer',
    'Bearer ',
    'Bearer  two-spaces',
    'Bearer a b',
    'Bearer a\r\nb',
    'Token abc',
    'abc',
  ])('returns undefined for %j', (header) => {
    expect(bearerToken(header)).toBeUndefined();
  });
});
