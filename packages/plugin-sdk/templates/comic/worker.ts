import {
  defineContentProvider,
  definePlugin,
  pluginManifestSchema,
  PluginError,
} from '@readest/plugin-sdk';
import manifest from './manifest.json';

const work = {
  id: 'example-comic',
  title: 'Example comic',
  author: 'Example artist',
  kind: 'comic' as const,
};
const provider = defineContentProvider({
  id: 'example-comic',
  async search() {
    return { items: [work] };
  },
  async getWork() {
    return work;
  },
  async getChapters() {
    return { items: [{ id: 'episode-one', title: 'Episode one' }] };
  },
  async resolveChapter(_input, host) {
    const url = host.source.config['imageUrl'];
    if (typeof url !== 'string' || !url)
      throw new PluginError(
        'Configure an image URL in this source instance',
        'CONFIGURATION_REQUIRED',
      );
    return { kind: 'pages', pages: [{ id: 'episode-one-page-one', url }] };
  },
  async resolveResource({ resource }) {
    if (!resource.url) throw new PluginError('Image URL is missing', 'RESOURCE_UNAVAILABLE');
    return { url: resource.url };
  },
});
definePlugin({
  manifest: pluginManifestSchema.parse(manifest),
  contentProviders: [provider],
}).start();
