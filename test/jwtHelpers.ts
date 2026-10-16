import { createHmac, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';

export interface KeyPair {
  privateKey: KeyObject;
  publicPem: string;
}

export interface TestKeys {
  rsa: KeyPair;
  rsa2: KeyPair;
  ec: KeyPair;
  ec2: KeyPair;
  hmacSecret: string;
}

let cached: TestKeys | undefined;

const pair = (type: 'rsa' | 'ec'): KeyPair => {
  const { privateKey, publicKey } =
    type === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string };
};

/** Generated once per test file: RSA generation costs a few hundred milliseconds. */
export function testKeys(): TestKeys {
  cached ??= {
    rsa: pair('rsa'),
    rsa2: pair('rsa'),
    ec: pair('ec'),
    ec2: pair('ec'),
    hmacSecret: 'a-test-hmac-secret-of-at-least-32-bytes!!',
  };
  return cached;
}

const b64 = (v: string | Buffer): string => Buffer.from(v).toString('base64url');

export interface SignOptions {
  /** Algorithm used to compute the signature. */
  alg: 'HS256' | 'RS256' | 'ES256';
  /** HMAC secret (string) or private key. */
  key: string | KeyObject;
  /** Header members; `alg` defaults to the signing algorithm but can be overridden to forge a mismatch. */
  header?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  /** Raw JSON text instead of an object, for duplicate members and other things JSON.stringify cannot write. */
  headerJson?: string;
  payloadJson?: string;
  /** Sign ES256 with the DER encoding OpenSSL produces by default, instead of the raw R||S a JWS requires. */
  derSignature?: boolean;
}

export function signJwt(options: SignOptions): string {
  const header = options.headerJson ?? JSON.stringify({ alg: options.alg, typ: 'JWT', ...options.header });
  const payload = options.payloadJson ?? JSON.stringify(options.payload ?? {});
  const input = `${b64(header)}.${b64(payload)}`;

  let signature: Buffer;
  if (options.alg === 'HS256') {
    signature = createHmac('sha256', options.key as string)
      .update(input)
      .digest();
  } else if (options.alg === 'RS256') {
    signature = sign('sha256', Buffer.from(input), options.key as KeyObject);
  } else {
    signature = options.derSignature
      ? sign('sha256', Buffer.from(input), options.key as KeyObject)
      : sign('sha256', Buffer.from(input), { key: options.key as KeyObject, dsaEncoding: 'ieee-p1363' });
  }
  return `${input}.${signature.toString('base64url')}`;
}

/** Re-encode one segment of a token (0 header, 1 payload) without re-signing, to simulate tampering. */
export function tamper(token: string, segment: 0 | 1, mutate: (obj: Record<string, unknown>) => void): string {
  const parts = token.split('.');
  const obj = JSON.parse(Buffer.from(parts[segment] as string, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  mutate(obj);
  parts[segment] = b64(JSON.stringify(obj));
  return parts.join('.');
}
