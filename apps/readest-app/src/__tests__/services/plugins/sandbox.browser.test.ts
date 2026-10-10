import { describe, expect, it } from 'vitest';
import { createSandboxedPluginWorker } from '@/services/plugins/sandbox';

describe('external plugin worker isolation', () => {
  it('exchanges messages while denying direct networking, storage and host access', async () => {
    const source = `
      onmessage = async ({data}) => {
        const result = { echo: data, document: typeof document, tauri: typeof __TAURI_INTERNALS__ };
        try { indexedDB.open('readest-host-data'); result.storage = 'allowed'; }
        catch (error) { result.storage = error.name; }
        // A data URL succeeds without DNS/CORS when CSP is absent. A deliberately
        // invalid hostname would fail even if network isolation were broken.
        try { await fetch('data:text/plain,plugin-probe'); result.network = 'allowed'; }
        catch (error) { result.network = error.name; }
        try { Function('return 1')(); result.eval = 'allowed'; }
        catch (error) { result.eval = error.name; }
        postMessage(result);
      };
    `;
    const worker = createSandboxedPluginWorker(source);
    try {
      const received = new Promise<unknown>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(event.message));
      });
      worker.postMessage('host message');
      await expect(received).resolves.toEqual({
        echo: 'host message',
        document: 'undefined',
        tauri: 'undefined',
        storage: 'SecurityError',
        network: 'TypeError',
        eval: 'EvalError',
      });
    } finally {
      worker.terminate();
    }
  });

  it('terminates queued requests', async () => {
    const worker = createSandboxedPluginWorker('onmessage = e => postMessage(e.data);');
    worker.terminate();
    expect(() => worker.postMessage('after termination')).toThrow();
  });
});
