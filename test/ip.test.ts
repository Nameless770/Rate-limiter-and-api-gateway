import { describe, expect, it } from 'vitest';
import { isLoopbackHost, normalizeIp } from '../src/net/ip.js';

describe('normalizeIp', () => {
  it('leaves IPv4 alone', () => {
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
  });

  it('treats IPv4-mapped IPv6 as the IPv4 address, so one client has one identity', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('::ffff:cb00:7107')).toBe('203.0.113.7'); // the same address in hex form
  });

  it('collapses an IPv6 /64 to one identity', () => {
    const a = normalizeIp('2001:db8:abcd:12:1111:2222:3333:4444');
    const b = normalizeIp('2001:db8:abcd:12:ffff:eeee:dddd:cccc');
    const other = normalizeIp('2001:db8:abcd:13::1');
    expect(a).toBe('2001:db8:abcd:12:0:0:0:0/64');
    expect(b).toBe(a);
    expect(other).not.toBe(a);
  });

  it('is insensitive to how the same address is written', () => {
    const forms = ['2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001', '2001:DB8:0:0:0:0:0:1', '[2001:db8::1]'];
    expect(new Set(forms.map((f) => normalizeIp(f))).size).toBe(1);
  });

  it('ignores a zone identifier', () => {
    expect(normalizeIp('fe80::1%eth0')).toBe(normalizeIp('fe80::1'));
  });

  it('honours a different prefix length', () => {
    const a = normalizeIp('2001:db8:1:2:3:4:5:6', 48);
    const b = normalizeIp('2001:db8:1:ffff::9', 48);
    expect(a).toBe('2001:db8:1:0:0:0:0:0/48');
    expect(b).toBe(a);
    // A prefix that ends mid-group masks bits inside the group.
    expect(normalizeIp('2001:db8:1:2:3:4:5:6', 52)).toBe('2001:db8:1:0:0:0:0:0/52');
    expect(normalizeIp('2001:db8:1:f234::1', 52)).toBe('2001:db8:1:f000:0:0:0:0/52');
  });

  it('handles the unspecified and loopback addresses', () => {
    expect(normalizeIp('::')).toBe('0:0:0:0:0:0:0:0/64');
    expect(normalizeIp('::1')).toBe('0:0:0:0:0:0:0:0/64');
  });

  it.each(['', '   ', 'not an ip', '999.1.1.1', '1.2.3', '2001:db8::zz', '12345::1', '1::2::3', "' OR 1=1 --"])(
    'returns undefined for %j, so hostile text is never used as a key',
    (value) => {
      expect(normalizeIp(value)).toBeUndefined();
    },
  );

  it('returns undefined for undefined', () => {
    expect(normalizeIp(undefined)).toBeUndefined();
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', 'LOCALHOST'])('%s is loopback', (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });
  it.each(['0.0.0.0', '10.0.0.5', '::', '192.168.1.1', 'example.com', ''])('%s is not', (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});
