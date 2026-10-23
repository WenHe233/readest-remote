import { pluginReleaseAssets } from './plugin-release-lock.mjs';

export function validateExperimentalPluginLock(pin) {
  const required = ['io.github.wenhe233.legado', 'io.github.wenhe233.venera'];
  if (!/^[a-f0-9]{40}$/.test(pin.revision || '') || !pin.release ||
      required.some((id) => !pin.plugins?.some((plugin) => plugin.id === id && plugin.version &&
        /^[a-f0-9]{64}$/.test(plugin.fingerprint || pin.fingerprint || '')))) {
    throw new Error('Experimental compatibility engines are not release-pinned. Publish the independent plugins and update external-plugins.lock.json before running experimental CI or release.');
  }
  pluginReleaseAssets(pin);
}
