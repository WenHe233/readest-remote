/**
 * Returns an AbortSignal that fires when EITHER input fires. The
 * listeners are removed on abort. Call `cleanup` when an operation finishes
 * before cancellation, so long-lived inputs do not retain completed work.
 * Uses AbortController for WebViews without the static AbortSignal.any API.
 */
export function anySignal(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; fn: () => void }> = [];

  const cleanup = (): void => {
    for (const { signal, fn } of listeners) signal.removeEventListener('abort', fn);
    listeners.length = 0;
    controller.signal.removeEventListener('abort', cleanup);
  };
  controller.signal.addEventListener('abort', cleanup, { once: true });

  for (const sig of signals) {
    if (!sig) continue;
    if (sig.aborted) {
      controller.abort(sig.reason);
      break;
    }
    const fn = (): void => controller.abort(sig.reason);
    sig.addEventListener('abort', fn, { once: true });
    listeners.push({ signal: sig, fn });
  }

  return { signal: controller.signal, cleanup };
}
