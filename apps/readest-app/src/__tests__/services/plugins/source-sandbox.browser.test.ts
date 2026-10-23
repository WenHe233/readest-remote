import { describe, expect, it } from 'vitest';
import { verifyPluginPackage } from '@/services/plugins/package';
import { createPluginRuntime } from '@/services/plugins/runtime';
import { createSandboxedPluginWorker } from '@/services/plugins/sandbox';
import type { SourceContext } from '@readest/plugin-sdk';
declare const __SOURCE_TEST_PACKAGES__: Record<string, string>;

const definitions = {
  legado: JSON.stringify({
    bookSourceName: 'Sandbox fixture',
    bookSourceUrl: 'https://test.example',
    searchUrl: '/search?q={{key}}',
    ruleSearch: { bookList: '.book', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text', tocUrl: '#toc@href' },
    ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '#content@html' },
  }),
  venera: `class TestSource extends ComicSource {
    name='Sandbox fixture';key='fixture';version='1';
    init(){this.saveData('initialized',true)}
    search={load:async()=>({comics:[new Comic({id:'work',title:JSON.parse((await Network.get('https://test.example/search')).body).title})],maxPage:1})};
    comic={loadInfo:async()=>new ComicDetails({title:'Novel',chapters:{chapter:'Chapter'}}),loadEp:async()=>['https://test.example/image'],onImageLoad:url=>({url,headers:{Referer:'https://test.example/'}})};
  }`,
};

describe('signed compatibility workers under the production sandbox', () => {
  for (const name of ['legado', 'venera'] as const)
    it(`${name} runs delayed broker IO without AbortSignal.any`, async () => {
      const pkg = await verifyPluginPackage(
        Uint8Array.from(atob(__SOURCE_TEST_PACKAGES__[name]!), (char) => char.charCodeAt(0)),
      );
      const state = new Map<string, unknown>();
      const context: SourceContext = {
        instance: 'host-owned-lease',
        providerId: name,
        config: {},
        networkOrigins: ['https://test.example'],
      };
      let networkCalls = 0;
      const runtime = createPluginRuntime({
        createWorker: () =>
          createSandboxedPluginWorker(
            `Object.defineProperty(AbortSignal,'any',{value:undefined,configurable:true});\n${pkg.workerSource}`,
            pkg.resources,
            { wasm: true },
          ),
        handleHostCall: async (call) => {
          if (!('instance' in call.payload) || call.payload.instance !== context.instance)
            throw new Error('Wrong source lease');
          if (call.capability === 'source.storage.get') return state.get(call.payload.key) ?? null;
          if (call.capability === 'source.storage.set') {
            state.set(call.payload.key, call.payload.value);
            return { saved: true };
          }
          if (call.capability === 'source.cookies.get') return { cookie: '' };
          if (call.capability === 'source.http') {
            networkCalls++;
            // Force QuickJS's pending-host-operation branch on both Chromium and WebKit.
            await new Promise((resolve) => setTimeout(resolve, 25));
            const responses: Record<string, string> =
              name === 'venera'
                ? { '/search': '{"title":"Novel"}' }
                : {
                    '/search': '<div class="book"><a href="/book">Novel</a></div>',
                    '/book': '<h1>Novel</h1><a id="toc" href="/toc">TOC</a>',
                    '/toc': '<div class="chapter"><a href="/chapter">Chapter</a></div>',
                    '/chapter': '<div id="content"><p>Read me</p></div>',
                  };
            return {
              status: 200,
              url: call.payload.url,
              headers: {},
              bytes: new TextEncoder().encode(responses[new URL(call.payload.url).pathname] ?? ''),
            };
          }
          throw new Error('Unexpected host capability: ' + call.capability);
        },
      });
      try {
        await runtime
          .call('ping', {}, { signal: AbortSignal.timeout(5000) })
          .catch((error: unknown) => {
            throw new Error('signed worker ping failed', { cause: error });
          });
        const inspected = await runtime
          .call(
            'source.inspect',
            { context, content: definitions[name], format: name },
            { signal: AbortSignal.timeout(5000) },
          )
          .catch((error: unknown) => {
            throw new Error('source inspection failed', { cause: error });
          });
        expect(networkCalls).toBe(0);
        context.definition = inspected.definitions[0];
        if (pkg.manifest.contributions.contentSources?.[0]?.capabilities.describe) {
          const description = await runtime.call('source.describe', { context });
          expect(description.authentication.kind).toBe('none');
          expect(networkCalls).toBe(0);
          expect(state.size).toBe(0);
        }
        const search = await runtime.call(
          'source.search',
          { context, query: 'Novel' },
          { signal: AbortSignal.timeout(20000) },
        );
        expect(search.items[0]?.title).toBe('Novel');
        const work = await runtime.call(
          'source.getWork',
          { context, work: search.items[0]! },
          { signal: AbortSignal.timeout(5000) },
        );
        const chapters = await runtime.call(
          'source.getChapters',
          { context, work },
          { signal: AbortSignal.timeout(5000) },
        );
        expect(chapters.items).toHaveLength(1);
        const content = await runtime.call(
          'source.resolveChapter',
          { context, work, chapter: chapters.items[0]! },
          { signal: AbortSignal.timeout(5000) },
        );
        if (content.kind === 'html') expect(content.html).toContain('Read me');
        else {
          expect(content.pages).toHaveLength(1);
          const resource = await runtime.call(
            'source.resolveResource',
            { context, work, chapter: chapters.items[0]!, resource: content.pages[0]! },
            { signal: AbortSignal.timeout(5000) },
          );
          expect(resource.headers?.['Referer']).toBe('https://test.example/');
        }
        expect(networkCalls).toBeGreaterThan(0);
      } finally {
        runtime.close();
      }
    });
  it('WASM permission leaves host eval, direct networking and storage denied', async () => {
    const worker = createSandboxedPluginWorker(
      `onmessage=async()=>{const out={};try{Function('return 1')();out.eval=true}catch{out.eval=false}try{await fetch('data:text/plain,no');out.network=true}catch{out.network=false}try{indexedDB.open('host');out.storage=true}catch{out.storage=false}out.wasm=typeof WebAssembly;postMessage(out)}`,
      {},
      { wasm: true },
    );
    try {
      const response = new Promise((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(event.message));
      });
      worker.postMessage({});
      await expect(response).resolves.toEqual({
        eval: false,
        network: false,
        storage: false,
        wasm: 'object',
      });
    } finally {
      worker.terminate();
    }
  });
});
