import { describe, expect, it } from 'vitest';
import {
  assertSourceUrl,
  normalizeSourceOrigin,
  SourceAccessError,
} from '@/services/contentSources/policy';
import { sourceCookieHeader, updateSourceCookies } from '@/services/contentSources/cookies';

describe('source network grants', () => {
  const grants = {
    origins: ['https://books.example', 'https://images.example'],
    allowPrivateNetwork: false,
  };
  it('requires an exact granted origin and rejects credentials and non-HTTP schemes', () => {
    expect(assertSourceUrl('https://books.example/read?id=1', grants).pathname).toBe('/read');
    for (const url of [
      'https://books.example.evil.org/a',
      'http://books.example/a',
      'file:///tmp/a',
      'https://name:secret@books.example/a',
    ]) {
      expect(() => assertSourceUrl(url, grants)).toThrow(SourceAccessError);
    }
    expect(normalizeSourceOrigin('https://BOOKS.example:443/path')).toBe('https://books.example');
  });
  it('blocks alternate loopback encodings and private IPv6 even with an origin grant', () => {
    for (const raw of [
      'http://2130706433',
      'http://0x7f000001',
      'http://[::ffff:7f00:1]',
      'http://[fd00::1]',
      'http://server.local',
      'http://169.254.169.254',
    ]) {
      const origins = [new URL(raw).origin];
      expect(() => assertSourceUrl(raw, { origins, allowPrivateNetwork: false })).toThrow();
      expect(assertSourceUrl(raw, { origins, allowPrivateNetwork: true }).origin).toBe(origins[0]);
    }
  });
});

describe('instance cookie jar', () => {
  it('accepts intermediate parent domains without widening to unrelated tenants', () => {
    const jar = updateSourceCookies([], 'https://api.login.example.com/', [
      'sid=ok; Domain=login.example.com; Path=/; Secure',
    ]);
    expect(sourceCookieHeader(jar, 'https://www.login.example.com/')).toBe('sid=ok');
    expect(sourceCookieHeader(jar, 'https://other.example.com/')).toBe('');
  });
  it('does not let a plaintext response overwrite an existing secure cookie', () => {
    const original = updateSourceCookies([], 'https://example.com/', [
      'sid=secret; Path=/; Secure',
    ]);
    const replaced = updateSourceCookies(original, 'http://example.com/', ['sid=injected; Path=/']);
    expect(sourceCookieHeader(replaced, 'https://example.com/')).toBe('sid=secret');
  });
  it('accepts a site parent domain while rejecting public and private suffixes', () => {
    const jar = updateSourceCookies([], 'https://www.example.co.uk/login', [
      'sid=value; Domain=example.co.uk; Path=/; Secure',
      'bad=x; Domain=co.uk; Path=/',
    ]);
    expect(sourceCookieHeader(jar, 'https://read.example.co.uk/chapter')).toBe('sid=value');
    expect(sourceCookieHeader(jar, 'https://other.co.uk/')).toBe('');
    expect(
      updateSourceCookies([], 'https://first.github.io/', ['shared=x; Domain=github.io; Path=/']),
    ).toEqual([]);
  });
  it('keeps cookies inside their host/path and enforces Secure, expiry and deletion', () => {
    const jar = updateSourceCookies(
      [],
      'https://books.example/account/login',
      ['sid=one; Path=/account; Secure; HttpOnly', 'theme=dark; Path=/'],
      1000,
    );
    expect(sourceCookieHeader(jar, 'https://books.example/account/page', 1100)).toBe(
      'sid=one; theme=dark',
    );
    expect(sourceCookieHeader(jar, 'http://books.example/account/page', 1100)).toBe('theme=dark');
    expect(sourceCookieHeader(jar, 'https://images.example/account/page', 1100)).toBe('');
    expect(sourceCookieHeader(jar, 'https://books.example/accounting', 1100)).toBe('theme=dark');
    const deleted = updateSourceCookies(
      jar,
      'https://books.example/account/login',
      ['sid=gone; Path=/account; Max-Age=0'],
      1200,
    );
    expect(sourceCookieHeader(deleted, 'https://books.example/account/page', 1300)).toBe(
      'theme=dark',
    );
  });
  it('rejects cookie domain widening and supports source-owned cookie imports', () => {
    const jar = updateSourceCookies(
      [],
      'https://books.example/',
      [
        'stolen=x; Domain=example',
        'foreign=x; Domain=images.example',
        'sid=ok; Domain=books.example; Path=/',
      ],
      1000,
    );
    expect(jar).toHaveLength(1);
    expect(sourceCookieHeader(jar, 'https://sub.books.example/', 1100)).toBe('sid=ok');
    expect(sourceCookieHeader(jar, 'https://images.example/', 1100)).toBe('');
  });
});
