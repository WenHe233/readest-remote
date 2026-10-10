# @readest/plugin-sdk

TypeScript SDK for Readest external plugin protocol V2. It depends on Zod and
has no host imports. Bundle the SDK and plugin dependencies into one classic
Worker (IIFE); the host does not resolve runtime package imports.

`src/contract.ts` and `src/worker.ts` extend the upstream Readest manifest, RPC,
validation, dictionary operations and cancellation machinery. Dictionary plugins
retain `probe`, `inspect`, `buildIndex`, `verifyIndex`, `lookup` and `readResource`.
The bundled Yomitan plugin remains in the host.

Library handlers implement `library.testConnection`, `library.listLibraries`,
`library.syncCatalog`, `library.getBook`, `library.resolveContent`,
`library.getCover`, `library.pullProgress` and `library.pushProgress`.
See the independently bundled [Kavita](../../plugins/kavita/src/plugin.ts) and
[Komga](../../plugins/komga/src/plugin.ts) examples.

```ts
import {
  startPluginWorkerServer,
  requestJson,
  type PluginOperationHandlers,
} from '@readest/plugin-sdk';

const handlers: PluginOperationHandlers = {
  async 'library.listLibraries'({ context }, host) {
    return requestJson(host, context, {
      path: '/api/libraries',
      auth: [{ secret: context.secrets['apiKey']!, in: 'header', name: 'X-API-Key' }],
    });
  },
  // Supply the other operations for a complete LibrarySource implementation.
};
startPluginWorkerServer(self, handlers);
```

The worker cannot use fetch, sockets, importScripts, host storage, DOM or Tauri.
Use `host.call('http.request', request)` or `requestJson`. Paths start with `/`
and are relative to the configured server, including its base path. The broker
checks connection ownership, permissions, credential handles and redirects.
Never include credentials in content descriptors, URLs or errors. The worker's
abort signal is canceled with its owning RPC; long loops should check it.

`LibraryContext` contains a connection handle, public scalar settings and opaque
secret handles. `RemoteBook` contains metadata and a revision string. Change the
revision when file content changes. A paginated catalog result must advance its
cursor, and only the final successful page may set `complete: true`; the host
does not remove unseen items after a partial scan.

`ContentDescriptor` is data, not executable code:

- `remote-file`: an authenticated resource and exact byte size; the host verifies
  `206 Content-Range` and reads aligned ranges.
- `epub-resources`: a `{path}` resource template and original-file download.
- `pages`: a `{page}` template, page count, first-page index and original download.

Reading positions describe EPUB anchors and fractions or fixed-layout page
indices. The host converts CFI/XPath/section positions; the plugin maps the server
wire format. Keep timestamp units in UTC milliseconds and mark approximations.

Use `storage.get`, `storage.set` and `storage.delete` for JSON data scoped to the
plugin and signer. Values are limited to 64 KiB and total storage to 2 MiB.
`readBundledResource(path)` reads a signed asset from the package; bundle code
dependencies at build time.

## Manifest and archive

The `.readest-plugin` ZIP contains `manifest.json`, `worker.js`, optional assets,
and `signature.json`. The manifest declares `id`, `name`, `pluginVersion`,
`protocolVersion: 2`, `entry: "worker.js"`, `pluginApi: {min: 2, max: 2}`,
permissions, contribution IDs, formats and declarative connection settings.
Supported setting types are `text`, `secret` and `boolean`.

The signature signs UTF-8 JSON `{format:1,files:[...]}`. Sort the file inventory
by ASCII path; each entry has `path`, byte `size`, and lowercase SHA-256. Include
every file except `signature.json`. The signature record includes algorithm
`Ed25519`, the base64 raw 32-byte public key, the inventory and base64 signature.
The signer fingerprint is SHA-256 of the raw public key.

Archive limits are 16 MiB compressed, 32 MiB expanded and 256 signed files.
Absolute paths, traversal, duplicate/case-colliding paths, Windows device names,
encrypted entries and unsigned additions are rejected. `readest.*` IDs belong to
bundled plugins. Use `scripts/build-plugins.mjs` as a reference signer/builder.

To build a plugin of your own, copy either reference plugin, change its manifest
ID, and keep `src/worker.ts` as the entry point. Import only this SDK. Place signed
assets in `resources/`; read them with `readBundledResource('resources/name')`.

```sh
pnpm --dir packages/plugin-sdk pack --out ../../.v2-artifacts/readest-plugin-sdk.tgz
node scripts/build-plugins.mjs --plugin ./plugins/my-source --key /private/signing.pem --out ./my-repository
```

The SDK tarball includes TypeScript sources for bundlers such as esbuild. Install
it from a local tarball in a separate project with `pnpm add /path/to/readest-plugin-sdk.tgz`.
The example packages require no host source files or runtime plugin dependencies.
