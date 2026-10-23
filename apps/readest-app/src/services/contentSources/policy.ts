import { isBlockedHost } from '@/utils/network';

export interface SourceNetworkGrants {
  origins: string[];
  allowPrivateNetwork: boolean;
}

export class SourceAccessError extends Error {
  constructor(
    message: string,
    readonly code = 'SOURCE_PERMISSION_DENIED',
    readonly origin?: string,
  ) {
    super(message);
    this.name = 'SourceAccessError';
  }
}

export function normalizeSourceOrigin(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new SourceAccessError('Source URLs must use HTTP or HTTPS without embedded credentials.');
  }
  return url.origin;
}

export function assertSourceUrl(value: string, grants: SourceNetworkGrants): URL {
  const origin = normalizeSourceOrigin(value);
  const url = new URL(value);
  if (!grants.origins.includes(origin)) {
    throw new SourceAccessError(
      `Allow this source to access ${origin} before retrying.`,
      'SOURCE_ORIGIN_REQUIRED',
      origin,
    );
  }
  if (!grants.allowPrivateNetwork && isBlockedHost(url.hostname.replace(/\.$/, ''))) {
    throw new SourceAccessError(
      'This source has no permission to access private network addresses.',
    );
  }
  url.hash = '';
  return url;
}
