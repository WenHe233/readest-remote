import { describe, expect, it } from 'vitest';
import { createSandboxedPluginWorker } from '@/services/plugins/sandbox';
import tauriConfig from '../../../../src-tauri/tauri.conf.json';

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

  it('starts beneath the production script CSP while retaining worker isolation', async () => {
    // Tauri adds nonces/hashes to the production page policy. This disables
    // unsafe-inline even though it remains in the configured script-src.
    const frame = document.createElement('iframe');
    const moduleUrl = new URL('../../../services/plugins/sandbox.ts', import.meta.url).href;
    const result = new Promise<unknown>((resolve, reject) => {
      const listener = (event: MessageEvent<unknown>) => {
        if (event.source !== frame.contentWindow) return;
        window.removeEventListener('message', listener);
        const data = event.data as { error?: string; result?: unknown };
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      };
      window.addEventListener('message', listener);
    });
    const hostScript = `
        import { createSandboxedPluginWorker } from ${JSON.stringify(moduleUrl)};
        const worker = createSandboxedPluginWorker(\`onmessage = async ({data}) => {
          const result = { echo: data, document: typeof document, tauri: typeof __TAURI_INTERNALS__ };
          try { indexedDB.open('readest-host-data'); result.storage = 'allowed'; }
          catch (error) { result.storage = error.name; }
          try { await fetch('data:text/plain,plugin-probe'); result.network = 'allowed'; }
          catch (error) { result.network = error.name; }
          try { Function('return 1')(); result.eval = 'allowed'; }
          catch (error) { result.eval = error.name; }
          postMessage(result);
        };\`);
        worker.onmessage = event => { parent.postMessage({result:event.data}, '*'); worker.terminate(); };
        worker.onerror = event => { parent.postMessage({error:event.message}, '*'); worker.terminate(); };
        worker.postMessage('production host');
      `;
    const hash = btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hostScript)),
        ),
      ),
    );
    const policy = {
      ...tauriConfig.app.security.csp,
      'script-src': tauriConfig.app.security.csp['script-src'] + ` 'sha256-${hash}'`,
    };
    const csp = Object.entries(policy)
      .map(([directive, sources]) => `${directive} ${sources}`)
      .join('; ');
    frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${csp}"><script type="module">${hostScript}</script>`;
    document.body.append(frame);
    try {
      await expect(result).resolves.toEqual({
        echo: 'production host',
        document: 'undefined',
        tauri: 'undefined',
        storage: 'SecurityError',
        network: 'TypeError',
        eval: 'EvalError',
      });
    } finally {
      frame.remove();
    }
  }, 20_000);

  it('terminates queued requests', async () => {
    const worker = createSandboxedPluginWorker('onmessage = e => postMessage(e.data);');
    worker.terminate();
    expect(() => worker.postMessage('after termination')).toThrow();
  });
});
