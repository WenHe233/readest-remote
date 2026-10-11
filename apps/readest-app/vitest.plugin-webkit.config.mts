import config from './vitest.browser.config.mts';

// Embedded Tauri assets use the CSP exercised by the sandbox test, without
// the Next.js web deployment's COOP/COEP headers. Match that native context.
config.server = { ...config.server, headers: {} };
config.cacheDir = 'node_modules/.vite-plugin-webkit';
config.test!.include = ['src/__tests__/services/plugins/sandbox.browser.test.ts'];
config.test!.fileParallelism = false;
config.test!.browser!.instances = [{ browser: 'webkit' }];

export default config;
