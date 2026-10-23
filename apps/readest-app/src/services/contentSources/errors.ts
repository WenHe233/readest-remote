export type SourceErrorStage =
  | 'request'
  | 'bridge'
  | 'dns'
  | 'proxy'
  | 'connect'
  | 'tls'
  | 'response'
  | 'download-list'
  | 'download-source'
  | 'inspect'
  | 'runtime'
  | 'search'
  | 'resource'
  | 'settings'
  | 'download';

const messages: Record<string, string> = {
  SOURCE_IMAGE_INVALID: 'This image could not be decoded',
  SOURCE_HTTP_DNS_FAILED: 'The source website could not be resolved',
  SOURCE_HTTP_DNS_RESERVED_ADDRESS:
    'The network returned a reserved address. Check the proxy DNS mode',
  SOURCE_HTTP_DNS64_DISCOVERY_FAILED: 'The network address translation could not be verified',
  SOURCE_HTTP_CONNECT_FAILED: 'Could not connect to the source website',
  SOURCE_HTTP_PROXY_FAILED: 'Could not read the system proxy configuration',
  SOURCE_HTTP_PROXY_UNSUPPORTED: 'This system proxy configuration is not supported',
  SOURCE_HTTP_TLS_FAILED: 'The source website certificate could not be verified',
  SOURCE_HTTP_NETWORK_FAILED: 'The source network request failed',
  SOURCE_HTTP_RESPONSE_FAILED: 'The source response was interrupted',
  SOURCE_HTTP_TIMEOUT: 'The source request timed out',
  SOURCE_HTTP_CANCELLED: 'Source operation cancelled',
  SOURCE_HTTP_PRIVATE_NETWORK_DENIED:
    'This source is not allowed to access private network addresses',
  SOURCE_HTTP_RESPONSE_TOO_LARGE: 'The source response exceeds the size limit',
  SOURCE_HTTP_STATUS: 'The source website returned an unsuccessful response',
  SOURCE_BRIDGE_DENIED: 'The native network command is not permitted',
  SOURCE_BRIDGE_UNAVAILABLE: 'The native network command is unavailable',
  SOURCE_RUNTIME_UNSUPPORTED: 'This source requires an unavailable runtime feature',
  SOURCE_ORIGIN_REQUIRED: 'Authorize this source website before retrying',
  SOURCE_PERMISSION_DENIED: 'This source operation has not been authorized',
  SOURCE_PLATFORM_UNSUPPORTED: 'This source operation is unavailable on this platform',
  SOURCE_NETWORK_FAILED: 'The source network request failed',
  SOURCE_LIMIT_EXCEEDED: 'The source operation exceeds its resource limit',
  UNSUPPORTED_CAPABILITY: 'This source requires an unsupported capability',
  SOURCE_OPERATION_FAILED: 'Source operation failed',
};
const nativeStage = (code: string): SourceErrorStage => {
  if (code.includes('DNS')) return 'dns';
  if (code.includes('PROXY')) return 'proxy';
  if (code.includes('TLS')) return 'tls';
  if (code.includes('CONNECT')) return 'connect';
  if (code.includes('RESPONSE') || code === 'SOURCE_HTTP_STATUS') return 'response';
  if (code.startsWith('SOURCE_BRIDGE')) return 'bridge';
  return 'request';
};
const retryableCode = (code: string) =>
  /(?:DNS_FAILED|PROXY_FAILED|NETWORK_FAILED|CONNECT_FAILED|RESPONSE_FAILED|TIMEOUT)$/.test(code);

export class SourceOperationError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  constructor(
    readonly code: string,
    readonly stage: SourceErrorStage = nativeStage(code),
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(messages[code] ?? messages['SOURCE_OPERATION_FAILED']);
    this.name = code === 'SOURCE_HTTP_CANCELLED' ? 'AbortError' : 'SourceOperationError';
    this.status = options.status;
    this.retryable =
      options.retryable ??
      (retryableCode(code) || options.status === 429 || (options.status ?? 0) >= 500);
  }
}

export function normalizeSourceError(
  error: unknown,
  stage?: SourceErrorStage,
): SourceOperationError {
  if (error instanceof SourceOperationError) return error;
  const original = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const diagnostic = original['diagnostic'];
  const record =
    diagnostic && typeof diagnostic === 'object'
      ? ({
          ...diagnostic,
          code: original['code'],
          name: original['name'],
          message: original['message'],
        } as Record<string, unknown>)
      : original;
  const value = typeof error === 'string' ? error : record['code'];
  let code =
    typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(value)
      ? value
      : 'SOURCE_OPERATION_FAILED';
  if (record['name'] === 'AbortError') code = 'SOURCE_HTTP_CANCELLED';
  if (record['name'] === 'TimeoutError') code = 'SOURCE_HTTP_TIMEOUT';
  if (code === 'SOURCE_OPERATION_FAILED') {
    const message =
      typeof error === 'string'
        ? error
        : typeof record['message'] === 'string'
          ? record['message']
          : '';
    if (/^[A-Z][A-Z0-9_]{1,127}$/.test(message)) code = message;
    else if (/AbortSignal\.any.*not.*function/.test(message)) code = 'SOURCE_RUNTIME_UNSUPPORTED';
    else if (/not allowed|permission denied/i.test(message)) code = 'SOURCE_BRIDGE_DENIED';
    else if (/unknown command|command .+ not found/i.test(message))
      code = 'SOURCE_BRIDGE_UNAVAILABLE';
  }
  const stages: SourceErrorStage[] = [
    'request',
    'bridge',
    'dns',
    'proxy',
    'connect',
    'tls',
    'response',
    'download-list',
    'download-source',
    'inspect',
    'runtime',
    'search',
    'resource',
    'settings',
    'download',
  ];
  const native =
    typeof record['stage'] === 'string' && stages.includes(record['stage'] as SourceErrorStage)
      ? (record['stage'] as SourceErrorStage)
      : undefined;
  const status =
    typeof record['status'] === 'number' &&
    Number.isInteger(record['status']) &&
    record['status'] >= 100 &&
    record['status'] <= 599
      ? record['status']
      : undefined;
  return new SourceOperationError(code, native ?? stage ?? nativeStage(code), {
    status,
    retryable: typeof record['retryable'] === 'boolean' ? record['retryable'] : undefined,
  });
}

export function sourceErrorMessage(
  error: unknown,
  translate: (message: string) => string = (message) => message,
): string {
  const failure = normalizeSourceError(error);
  return `${translate(failure.message)}${failure.status ? ` (HTTP ${failure.status})` : ''}`;
}

/** Deliberately excludes raw messages, URLs, response bodies and credential values. */
export function sourceErrorDiagnostic(error: unknown, operation?: SourceErrorStage): string {
  const failure = normalizeSourceError(error);
  return JSON.stringify(
    {
      operation,
      code: failure.code,
      stage: failure.stage,
      status: failure.status,
      retryable: failure.retryable,
    },
    null,
    2,
  );
}
