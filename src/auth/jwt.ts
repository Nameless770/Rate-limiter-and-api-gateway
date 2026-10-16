/**
 * JSON Web Token verification (RFC 7519 / 7515) for HS256, RS256 and ES256, on top of node:crypto.
 *
 * Verifying a JWT is easy to get subtly wrong, and every classic JWT vulnerability is a case of letting the
 * *token* decide how it is checked. The rules here, each tested, are:
 *
 *  - The algorithm comes from configuration. A token's `alg` header is only compared against it: `none` can never
 *    match, and a token cannot ask to be verified with a different algorithm than the key was provisioned for
 *    (the RS256-public-key-as-HMAC-secret confusion attack).
 *  - Keys are chosen by configured issuer/`kid`, never from anything inside the token, and weak ones (short HMAC
 *    secrets, RSA under 2048 bits, EC other than P-256) are refused at startup.
 *  - Claims are read only after the signature has verified, and only the types that make sense are accepted
 *    (`exp` as a number, not the string "9999999999").
 *  - Anything that two JSON parsers could read differently is rejected rather than interpreted: duplicate member
 *    names, critical-header extensions we do not implement, oversized tokens.
 *  - HMAC comparison is constant-time.
 *
 * Deliberately not here: fetching keys from a JWKS URL (it adds an outbound request, a cache and an SSRF surface;
 * keys are configured statically and rotated by listing both), and encrypted tokens (JWE).
 */
import { createHmac, createPublicKey, type KeyObject, timingSafeEqual, verify } from 'node:crypto';

export type JwtAlgorithm = 'HS256' | 'RS256' | 'ES256';

export interface JwtIssuer {
  /** For logs, metrics and rate-limit identities. Never taken from the token. */
  name: string;
  alg: JwtAlgorithm;
  /** HMAC secret (HS256). */
  secret?: Buffer;
  /** Public key (RS256, ES256). */
  publicKey?: KeyObject;
  /** If set, a token must carry this `kid`. If unset, the issuer matches tokens with any `kid` (or none). */
  kid?: string;
  /** Required value of the `iss` claim. */
  issuer?: string;
  /** Value that must appear in `aud`. */
  audience?: string;
  /** Clock skew tolerated on exp / nbf / iat, in seconds. */
  leewaySeconds: number;
  /** Reject tokens valid for longer than this, in seconds (exp - iat, or time left until exp without an iat). */
  maxLifetimeSeconds?: number;
  /** Named rate-limit plan for subjects of this issuer. */
  plan?: string;
}

export type JwtFailure =
  | 'malformed'
  | 'too_large'
  | 'unsupported_alg'
  | 'unknown_key'
  | 'bad_issuer'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'bad_audience'
  | 'missing_claim'
  | 'too_long_lived';

export type JwtResult = { ok: true; issuer: JwtIssuer; subject: string } | { ok: false; reason: JwtFailure };

/** Longest token accepted. Real tokens are a few hundred bytes to a couple of KB; this bounds work per request. */
export const MAX_TOKEN_BYTES = 8192;
const MAX_SUBJECT_CHARS = 256;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const fail = (reason: JwtFailure): JwtResult => ({ ok: false, reason });

export class JwtVerifier {
  constructor(
    private readonly issuers: readonly JwtIssuer[],
    private readonly now: () => number = Date.now,
  ) {}

  verify(token: string): JwtResult {
    if (token.length > MAX_TOKEN_BYTES) return fail('too_large');

    const parts = token.split('.');
    if (parts.length !== 3) return fail('malformed');
    const [h, p, s] = parts as [string, string, string];
    if (!BASE64URL.test(h) || !BASE64URL.test(p) || !BASE64URL.test(s)) return fail('malformed');

    const headerJson = Buffer.from(h, 'base64url').toString('utf8');
    const payloadJson = Buffer.from(p, 'base64url').toString('utf8');
    if (hasDuplicateMembers(headerJson) || hasDuplicateMembers(payloadJson)) return fail('malformed');

    const header = parseObject(headerJson);
    const payload = parseObject(payloadJson);
    if (!header || !payload) return fail('malformed');

    // We implement no header extensions, and RFC 7515 says to reject a token that marks any as critical.
    if ('crit' in header || header['b64'] === false) return fail('malformed');
    if (typeof header['alg'] !== 'string') return fail('malformed');

    // 1. Which configured keys could possibly apply? The token narrows the choice; it never widens it.
    const byAlg = this.issuers.filter((i) => i.alg === header['alg']);
    if (byAlg.length === 0) return fail('unsupported_alg');
    const tokenKid = typeof header['kid'] === 'string' ? header['kid'] : undefined;
    const byKid = byAlg.filter((i) => i.kid === undefined || i.kid === tokenKid);
    if (byKid.length === 0) return fail('unknown_key');
    const candidates = byKid.filter((i) => i.issuer === undefined || i.issuer === payload['iss']);
    if (candidates.length === 0) return fail('bad_issuer');

    // 2. Signature. Candidates exist for key rotation (several keys for one issuer): the first that verifies wins.
    const signingInput = Buffer.from(`${h}.${p}`, 'ascii');
    const signature = Buffer.from(s, 'base64url');
    const issuer = candidates.find((c) => signatureValid(c, signingInput, signature));
    if (!issuer) return fail('bad_signature');

    // 3. Claims, only now that the contents are known to be authentic.
    return this.checkClaims(issuer, payload);
  }

  private checkClaims(issuer: JwtIssuer, claims: Record<string, unknown>): JwtResult {
    const nowSec = this.now() / 1000;
    const leeway = issuer.leewaySeconds;

    const exp = claims['exp'];
    if (exp === undefined) return fail('missing_claim');
    if (!isNumber(exp)) return fail('malformed');
    if (nowSec >= exp + leeway) return fail('expired');

    const nbf = claims['nbf'];
    if (nbf !== undefined) {
      if (!isNumber(nbf)) return fail('malformed');
      if (nowSec < nbf - leeway) return fail('not_yet_valid');
    }
    const iat = claims['iat'];
    if (iat !== undefined) {
      if (!isNumber(iat)) return fail('malformed');
      if (iat - leeway > nowSec) return fail('not_yet_valid'); // issued in the future
    }

    if (issuer.maxLifetimeSeconds !== undefined) {
      const lifetime = isNumber(iat) ? exp - iat : exp - nowSec - leeway;
      if (lifetime > issuer.maxLifetimeSeconds) return fail('too_long_lived');
    }

    if (issuer.audience !== undefined) {
      const aud = claims['aud'];
      const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : [];
      if (!audiences.includes(issuer.audience)) return fail('bad_audience');
    }

    const sub = claims['sub'];
    if (typeof sub !== 'string' || sub.length === 0 || sub.length > MAX_SUBJECT_CHARS) return fail('missing_claim');

    return { ok: true, issuer, subject: sub };
  }
}

function signatureValid(issuer: JwtIssuer, signingInput: Buffer, signature: Buffer): boolean {
  try {
    switch (issuer.alg) {
      case 'HS256': {
        if (!issuer.secret) return false;
        const expected = createHmac('sha256', issuer.secret).update(signingInput).digest();
        return signature.length === expected.length && timingSafeEqual(signature, expected);
      }
      case 'RS256':
        return issuer.publicKey !== undefined && verify('sha256', signingInput, issuer.publicKey, signature);
      case 'ES256':
        // JWS carries ECDSA signatures as raw R||S (64 bytes), not the DER form OpenSSL defaults to. A DER
        // signature is a different encoding of the same math and must not be accepted as a JWS.
        return (
          issuer.publicKey !== undefined &&
          signature.length === 64 &&
          verify('sha256', signingInput, { key: issuer.publicKey, dsaEncoding: 'ieee-p1363' }, signature)
        );
    }
  } catch {
    return false; // malformed key/signature material is just "does not verify"
  }
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseObject(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True if the top-level object repeats a member name. `JSON.parse` keeps the last one, but another parser (the
 * upstream's, which may receive this very token) can keep the first, and "we saw one `sub`, they saw another" is
 * an authentication bypass. RFC 7519 allows rejecting such tokens, so we do.
 */
export function hasDuplicateMembers(json: string): boolean {
  const seen = new Set<string>();
  let depth = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '"') {
      const start = i;
      i++;
      while (i < json.length && json[i] !== '"') i += json[i] === '\\' ? 2 : 1;
      if (depth === 1) {
        // A string at depth 1 is a member name when the next non-space character is a colon.
        let j = i + 1;
        while (j < json.length && /\s/.test(json[j] as string)) j++;
        if (json[j] === ':') {
          let name: string;
          try {
            name = JSON.parse(json.slice(start, i + 1)) as string;
          } catch {
            return true; // not valid JSON; refuse rather than guess
          }
          if (seen.has(name)) return true;
          seen.add(name);
        }
      }
    } else if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
    }
  }
  return false;
}

/** Extract the token from `Authorization: Bearer <token>`; undefined for any other scheme or shape. */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/i.exec(header);
  return match?.[1];
}

// ---------------------------------------------------------------------------------------------------------------
// Loading keys from configuration
// ---------------------------------------------------------------------------------------------------------------

export interface JwtIssuerSource {
  name: string;
  alg: JwtAlgorithm;
  secret?: string | undefined;
  publicKey?: string | undefined;
  publicKeyFile?: string | undefined;
  kid?: string | undefined;
  issuer?: string | undefined;
  audience?: string | undefined;
  leewaySeconds: number;
  maxLifetimeSeconds?: number | undefined;
  plan?: string | undefined;
}

export class JwtKeyError extends Error {
  constructor(issuer: string, message: string) {
    super(`auth.jwt.issuers.${issuer}: ${message}`);
    this.name = 'JwtKeyError';
  }
}

const MIN_HMAC_SECRET_BYTES = 32;
const MIN_RSA_BITS = 2048;

/** Build usable issuers from their configuration, refusing weak or mismatched keys. */
export function loadIssuer(source: JwtIssuerSource, readFile: (path: string) => string): JwtIssuer {
  const { name, alg } = source;
  const base = {
    name,
    alg,
    kid: source.kid,
    issuer: source.issuer,
    audience: source.audience,
    leewaySeconds: source.leewaySeconds,
    maxLifetimeSeconds: source.maxLifetimeSeconds,
    plan: source.plan,
  };

  if (alg === 'HS256') {
    if (source.publicKey || source.publicKeyFile) throw new JwtKeyError(name, 'HS256 uses "secret", not a public key');
    if (!source.secret) throw new JwtKeyError(name, 'HS256 needs a "secret"');
    const secret = Buffer.from(source.secret, 'utf8');
    if (secret.length < MIN_HMAC_SECRET_BYTES) {
      throw new JwtKeyError(name, `the HMAC secret must be at least ${MIN_HMAC_SECRET_BYTES} bytes`);
    }
    return { ...base, secret };
  }

  if (source.secret) throw new JwtKeyError(name, `${alg} uses a public key, not a "secret"`);
  if ((source.publicKey === undefined) === (source.publicKeyFile === undefined)) {
    throw new JwtKeyError(name, 'set exactly one of "publicKey" and "publicKeyFile"');
  }
  let pem: string;
  try {
    pem = source.publicKey ?? readFile(source.publicKeyFile as string);
  } catch (error) {
    throw new JwtKeyError(name, `cannot read "${source.publicKeyFile}": ${(error as Error).message}`);
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(pem);
  } catch {
    throw new JwtKeyError(name, 'not a valid PEM public key');
  }

  if (alg === 'RS256') {
    if (publicKey.asymmetricKeyType !== 'rsa') throw new JwtKeyError(name, 'RS256 needs an RSA key');
    const bits = publicKey.asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits < MIN_RSA_BITS)
      throw new JwtKeyError(name, `the RSA key is ${bits} bits; at least ${MIN_RSA_BITS} required`);
  } else {
    if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new JwtKeyError(name, 'ES256 needs an EC key on the P-256 (prime256v1) curve');
    }
  }
  return { ...base, publicKey };
}
