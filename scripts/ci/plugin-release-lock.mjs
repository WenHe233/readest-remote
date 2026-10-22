export function pluginReleaseAssets(pin) {
  const names = Object.keys(pin.assets || {});
  if (!names.length || Object.values(pin.assets).some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Plugin release checksums are not pinned');
  }
  return Object.fromEntries(['source', 'sdk', 'examples'].map((role) => {
    const extension = role === 'sdk' ? 'tgz' : 'zip';
    const matches = names.filter((name) => new RegExp(`^readest-plugin-${role}-[0-9][0-9A-Za-z.-]*\\.${extension}$`).test(name));
    if (matches.length !== 1) throw new Error(`Pin exactly one plugin ${role} asset`);
    return [matches[0], `plugin-${role}.${extension}`];
  }));
}

export function validatePluginReleaseIndex(index, pin) {
  const expected = pin.plugins || [
    { id: 'io.github.wenhe233.kavita', version: '0.1.1' },
    { id: 'io.github.wenhe233.komga', version: '0.1.1' },
  ];
  if (!Array.isArray(expected) || !expected.length || !Array.isArray(index.plugins) ||
      index.plugins.length !== expected.length || new Set(index.plugins.map((plugin) => plugin.id)).size !== expected.length ||
      new Set(expected.map((plugin) => plugin.id)).size !== expected.length) throw new Error('Plugin release identity mismatch');
  for (const wanted of expected) {
    const plugin = index.plugins.find((candidate) => candidate.id === wanted.id);
    const fingerprint = wanted.fingerprint || pin.fingerprint;
    if (!plugin || plugin.version !== wanted.version || !/^[a-f0-9]{64}$/.test(fingerprint || '') ||
        plugin.fingerprint !== fingerprint || (wanted.channel && plugin.channel !== wanted.channel)) {
      throw new Error('Plugin release identity mismatch');
    }
  }
}
