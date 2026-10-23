import { describe, expect, it } from 'vitest';
import {
  normalizeSourceError,
  sourceErrorDiagnostic,
  sourceErrorMessage,
} from '@/services/contentSources/errors';

describe('system proxy diagnostics', () => {
  it('identifies unsupported proxy modes without suggesting a private-network grant', () => {
    const error = normalizeSourceError('SOURCE_HTTP_PROXY_UNSUPPORTED');
    expect(error.stage).toBe('proxy');
    expect(error.retryable).toBe(false);
    expect(sourceErrorMessage(error)).toBe('This system proxy configuration is not supported');
  });

  it('preserves the proxy stage and omits credentials from native errors', () => {
    const error = {
      code: 'SOURCE_HTTP_PROXY_FAILED',
      stage: 'proxy',
      message: 'http://user:secret@proxy.example:8080',
    };
    expect(JSON.parse(sourceErrorDiagnostic(error))).toEqual({
      code: 'SOURCE_HTTP_PROXY_FAILED',
      stage: 'proxy',
      retryable: true,
    });
    expect(sourceErrorMessage(error)).toBe('Could not read the system proxy configuration');
  });
});
