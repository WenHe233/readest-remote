import type { PluginWorkerLike } from './runtime';

// Only host-owned code executes in the frame. Plugin source arrives over a
// one-shot MessageChannel and executes exclusively in an opaque-origin worker.
const bootstrap = String.raw`
  let initialized = false;
  addEventListener('message', event => {
    if (initialized || event.source !== parent || event.ports.length !== 1) return;
    initialized = true;
    const port = event.ports[0];
    try {
      const prelude = "for (const name of ['Worker','SharedWorker']) Object.defineProperty(globalThis, name, {value:undefined,writable:false,configurable:false});\n";
      const url = URL.createObjectURL(new Blob([prelude, 'globalThis.__READEST_PLUGIN_RESOURCES__ = '+JSON.stringify(event.data.resources)+';\n', event.data.source], {type:'text/javascript'}));
      const worker = new Worker(url);
      worker.onmessage = e => port.postMessage({type:'message', data:e.data});
      worker.onerror = e => port.postMessage({type:'error', message:e.message || 'Plugin worker failed'});
      worker.onmessageerror = () => port.postMessage({type:'messageerror'});
      port.onmessage = e => {
        if (e.data.type === 'terminate') { worker.terminate(); URL.revokeObjectURL(url); port.close(); }
        else worker.postMessage(e.data.data);
      };
      port.start();
      port.postMessage({type:'ready'});
    } catch (error) { port.postMessage({type:'error', message:String(error)}); }
  });
`;

export function createSandboxedPluginWorker(
  source: string,
  resources: Record<string, string> = {},
): PluginWorkerLike {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('aria-hidden', 'true');
  frame.sandbox.add('allow-scripts');
  const nonce = crypto.randomUUID().replaceAll('-', '');
  // Embedded Tauri pages add script hashes to the inherited CSP, disabling
  // unsafe-inline. A data URL works with that policy and WebKit's prohibition
  // on loading parent-created blob URLs from an opaque frame. The frame still
  // authorizes only our nonce-bearing bootstrap, never arbitrary scripts.
  const bootstrapUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(bootstrap)}`;
  // A blob worker inherits this policy, including the ban on all direct
  // networking, imports and eval. Opaque origins cannot open host IndexedDB.
  frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'"><script nonce="${nonce}" src="${bootstrapUrl}"></script>`;
  const channel = new MessageChannel();
  let stopped = false;
  let ready = false;
  const queue: unknown[] = [];
  const timer = setTimeout(() => fail('Plugin sandbox did not start'), 15_000);
  const fail = (message: string) => {
    if (stopped) return;
    api.onerror?.(new ErrorEvent('error', { message }));
    api.terminate();
  };
  const api: PluginWorkerLike = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(data) {
      if (stopped) throw new Error('Plugin worker is terminated');
      if (ready) channel.port1.postMessage({ type: 'message', data });
      else queue.push(data);
    },
    terminate() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      channel.port1.postMessage({ type: 'terminate' });
      channel.port1.close();
      channel.port2.close();
      frame.remove();
      queue.length = 0;
    },
  };
  channel.port1.onmessage = (event: MessageEvent<unknown>) => {
    if (stopped || !event.data || typeof event.data !== 'object') return;
    const packet = event.data as { type?: string; data?: unknown; message?: string };
    if (packet.type === 'ready') {
      ready = true;
      clearTimeout(timer);
      for (const data of queue.splice(0)) channel.port1.postMessage({ type: 'message', data });
    } else if (packet.type === 'message') {
      api.onmessage?.(new MessageEvent('message', { data: packet.data }));
    } else if (packet.type === 'error') fail(packet.message || 'Plugin worker failed');
    else if (packet.type === 'messageerror') api.onmessageerror?.(event);
  };
  frame.onload = () => {
    if (!stopped) frame.contentWindow?.postMessage({ source, resources }, '*', [channel.port2]);
  };
  document.body.append(frame);
  return api;
}
