import { useEffect } from 'react';
import { getCurrent } from '@tauri-apps/plugin-deep-link';
import { getMatches } from '@tauri-apps/plugin-cli';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { isTauriAppPlatform } from '@/services/environment';
import { eventDispatcher } from '@/utils/event';
import { verifyPluginPackage } from '@/services/plugins/package';
import { parseRepositoryImport } from '@/services/plugins/repositories';
import { usePluginInbox } from '@/services/plugins/inbox';
const consumed = new Map<string, number>();
export function usePluginIngress(): void {
  const { appService } = useEnv();
  useEffect(() => {
    if (!appService) return;
    const receive = async (urls: string[]) => {
      for (const original of urls) {
        const isLink = original.startsWith('readest-remote://plugins/add-repository');
        if (!isLink && !/\.readest-(plugin|repo)$/iu.test(original)) continue;
        if (Date.now() - (consumed.get(original) ?? 0) < 2000) continue;
        consumed.set(original, Date.now());
        try {
          if (isLink) {
            const url = new URL(original).searchParams.get('url');
            if (!url) throw new Error('Repository URL is missing');
            usePluginInbox.setState({ repositoryUrl: url });
          } else {
            const path = original.startsWith('file://')
              ? decodeURIComponent(new URL(original).pathname).replace(/^\/([a-z]:)/iu, '$1')
              : original;
            await appService.allowPathsInScopes?.([path], false);
            const bytes = await appService.readFile(path, 'None', 'binary');
            if (typeof bytes === 'string') throw new Error('Cannot read plugin file');
            if (/\.readest-repo$/iu.test(path))
              usePluginInbox.setState({
                repositoryUrl: parseRepositoryImport(new TextDecoder().decode(bytes)),
              });
            else
              usePluginInbox.setState({
                candidate: await verifyPluginPackage(new Uint8Array(bytes)),
              });
          }
        } catch (error) {
          usePluginInbox.setState({
            error: error instanceof Error ? error.message : 'Plugin import failed',
          });
        }
        useSettingsStore.getState().setRequestedPanel('Plugins');
        useSettingsStore.getState().setSettingsDialogOpen(true);
      }
    };
    const handler = (event: CustomEvent) => void receive(event.detail.urls as string[]);
    eventDispatcher.on('app-incoming-url', handler);
    if (isTauriAppPlatform()) {
      void getCurrent()
        .then((urls) => receive(urls ?? []))
        .catch(() => {});
      void getMatches()
        .then((matches) =>
          receive(
            Object.values(matches.args).flatMap((arg) =>
              typeof arg.value === 'string'
                ? [arg.value]
                : Array.isArray(arg.value)
                  ? arg.value
                  : [],
            ),
          ),
        )
        .catch(() => {});
    }
    return () => eventDispatcher.off('app-incoming-url', handler);
  }, [appService]);
}
