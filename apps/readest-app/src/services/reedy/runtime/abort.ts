export { anySignal } from '@/utils/abort';

/**
 * Type guard so the runtime can distinguish AbortError-shaped exceptions
 * from real errors without doing instanceof against DOMException (which
 * isn't always available in Node).
 */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}
