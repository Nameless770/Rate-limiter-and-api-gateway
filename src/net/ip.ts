import { isIP } from 'node:net';

/**
 * Reduce a client address to the unit that should share one rate-limit identity.
 *
 *  - IPv4 stays as it is.
 *  - IPv4-mapped IPv6 (`::ffff:1.2.3.4`, which dual-stack sockets report) becomes plain IPv4, so one client
 *    can't hold two identities depending on how the socket was opened.
 *  - Any other IPv6 address is masked to its leading `ipv6Prefix` bits. A single subscriber is typically
 *    delegated a whole /64 (2^64 addresses), so keying on the full address would let one machine mint a fresh
 *    identity per request.
 *
 * Returns undefined for anything that isn't an IP address, so callers can fall back to something they trust
 * instead of using attacker-chosen text as a key.
 */
export function normalizeIp(raw: string | undefined, ipv6Prefix = 64): string | undefined {
  if (!raw) return undefined;
  let addr = raw.trim();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);

  const family = isIP(addr);
  if (family === 4) return addr;
  if (family !== 6) return undefined;

  const groups = expandIPv6(addr);
  if (!groups) return undefined;

  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) {
    const hi = groups[6] as number;
    const lo = groups[7] as number;
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }

  const masked = groups.map((group, i) => {
    const bits = Math.max(0, Math.min(16, ipv6Prefix - 16 * i));
    if (bits === 16) return group;
    if (bits === 0) return 0;
    return group & (0xffff << (16 - bits)) & 0xffff;
  });
  return `${masked.map((g) => g.toString(16)).join(':')}/${ipv6Prefix}`;
}

/** Eight 16-bit groups, or undefined if the text isn't a well-formed IPv6 address. */
function expandIPv6(addr: string): number[] | undefined {
  let text = addr;

  // An embedded dotted-quad tail (::ffff:1.2.3.4) is two more groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return undefined;
    const [a, b, c, d] = octets as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? (halves[0] as string).split(':') : [];
  const rest = halves.length === 2 && halves[1] ? (halves[1] as string).split(':') : [];

  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return undefined;
    groups = [...head, ...new Array<string>(fill).fill('0'), ...rest];
  }
  if (groups.length !== 8) return undefined;

  const numbers = groups.map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  return numbers.some(Number.isNaN) ? undefined : numbers;
}

/** True for addresses that only the local machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  return isIP(h) === 4 && h.startsWith('127.');
}
