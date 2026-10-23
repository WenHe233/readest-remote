import {
  defineContentProvider,
  definePlugin,
  pluginManifestSchema,
  PluginError,
} from '@readest/plugin-sdk';
import manifest from './manifest.json';

// This provider works without a compatibility engine, imported rules, or a server URL.
const work = {
  id: 'example-book',
  title: 'Example book',
  author: 'Example author',
  kind: 'text' as const,
};
const chapter = { id: 'chapter-one', title: 'Chapter one' };
const provider = defineContentProvider({
  id: 'example-text',
  async search({ query }) {
    return { items: work.title.toLowerCase().includes(query.toLowerCase()) ? [work] : [] };
  },
  async getWork() {
    return work;
  },
  async getChapters() {
    return { items: [chapter] };
  },
  async resolveChapter() {
    return {
      kind: 'html',
      html: '<h1>Chapter one</h1><p>This chapter was supplied by a native Readest plugin.</p>',
    };
  },
  async resolveResource() {
    throw new PluginError('This example has no external resources', 'RESOURCE_UNAVAILABLE');
  },
});
definePlugin({
  manifest: pluginManifestSchema.parse(manifest),
  contentProviders: [provider],
}).start();
