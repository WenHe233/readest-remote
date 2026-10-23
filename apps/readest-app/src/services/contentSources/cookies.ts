import { getDomain } from 'tldts';

export interface SourceCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
}

/** Jars are encrypted by the host, separately for every source instance. */
export function updateSourceCookies(
  previous: SourceCookie[],
  value: string,
  lines: string[],
  now = Date.now(),
): SourceCookie[] {
  const url = new URL(value);
  const jar = previous.filter((cookie) => cookie.expires === undefined || cookie.expires > now);
  for (const line of lines) {
    if (line.length > 8192 || /[\r\n]/u.test(line)) continue;
    const [pair = '', ...attributes] = line.split(';');
    const equals = pair.indexOf('=');
    if (equals < 1) continue;
    const name = pair.slice(0, equals).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu.test(name)) continue;
    const attrs = new Map(
      attributes.map((attr) => {
        const i = attr.indexOf('=');
        return [
          attr
            .slice(0, i < 0 ? undefined : i)
            .trim()
            .toLowerCase(),
          i < 0 ? '' : attr.slice(i + 1).trim(),
        ];
      }),
    );
    const domain = (attrs.get('domain') || url.hostname).replace(/^\./u, '').toLowerCase();
    // Parent-domain cookies are valid only within the same registrable domain.
    // Include private suffixes, so one github.io tenant cannot set another's cookies.
    const registeredDomain = getDomain(domain, { allowPrivateDomains: true });
    if (
      domain !== url.hostname &&
      (!url.hostname.endsWith(`.${domain}`) ||
        !registeredDomain ||
        getDomain(url.hostname, { allowPrivateDomains: true }) !== registeredDomain)
    )
      continue;
    const fallbackPath = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/';
    const requestedPath = attrs.get('path');
    const path = requestedPath?.startsWith('/') ? requestedPath : fallbackPath;
    let expires: number | undefined;
    const maxAge = attrs.get('max-age');
    if (maxAge !== undefined && /^-?\d+$/u.test(maxAge)) expires = now + Number(maxAge) * 1000;
    else if (attrs.has('expires')) {
      const parsed = Date.parse(attrs.get('expires')!);
      if (Number.isFinite(parsed)) expires = parsed;
    }
    const secure = attrs.has('secure');
    if ((secure && url.protocol !== 'https:') || (name.startsWith('__Secure-') && !secure))
      continue;
    if (name.startsWith('__Host-') && (!secure || attrs.has('domain') || path !== '/')) continue;
    if (
      url.protocol !== 'https:' &&
      jar.some(
        (cookie) =>
          cookie.secure &&
          cookie.name === name &&
          (cookie.domain === domain ||
            domain.endsWith(`.${cookie.domain}`) ||
            cookie.domain.endsWith(`.${domain}`)) &&
          (path === cookie.path ||
            path.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)),
      )
    )
      continue;
    const index = jar.findIndex(
      (cookie) => cookie.name === name && cookie.domain === domain && cookie.path === path,
    );
    if (index >= 0) jar.splice(index, 1);
    if (expires !== undefined && expires <= now) continue;
    jar.push({
      name,
      value: pair.slice(equals + 1).trim(),
      domain,
      hostOnly: !attrs.has('domain'),
      path,
      secure,
      httpOnly: attrs.has('httponly'),
      ...(expires === undefined ? {} : { expires }),
    });
  }
  return jar.slice(-256);
}

export function sourceCookieHeader(jar: SourceCookie[], value: string, now = Date.now()): string {
  const url = new URL(value);
  return jar
    .filter(
      (cookie) =>
        (cookie.expires === undefined || cookie.expires > now) &&
        (!cookie.secure || url.protocol === 'https:') &&
        (url.hostname === cookie.domain ||
          (!cookie.hostOnly && url.hostname.endsWith(`.${cookie.domain}`))) &&
        (url.pathname === cookie.path ||
          url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)),
    )
    .sort((a, b) => b.path.length - a.path.length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}
