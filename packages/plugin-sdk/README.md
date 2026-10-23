# @readest/plugin-sdk

TypeScript SDK for Readest plugin API 3 and external plugin protocol V2. API 2
dictionary and library plugins remain supported. The SDK depends on Zod and
has no host imports. Bundle the SDK and plugin dependencies into one classic
Worker (IIFE); the host does not resolve runtime package imports.

`src/contract.ts` and `src/worker.ts` extend the upstream Readest manifest, RPC,
validation, dictionary operations and cancellation machinery. Dictionary plugins
retain `probe`, `inspect`, `buildIndex`, `verifyIndex`, `lookup` and `readResource`.
The bundled Yomitan plugin remains in the host.

Library handlers implement `library.testConnection`, `library.listLibraries`,
`library.syncCatalog`, `library.getBook`, `library.resolveContent`,
`library.getCover`, `library.pullProgress` and `library.pushProgress`.
See the Kavita and Komga examples in the independent
[plugin repository](https://github.com/WenHe233/readest-remote-plugins).

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

## Native content providers (API 3)

Native providers use the same public API as compatibility plugins. They do not
need Legado, Venera, QuickJS, a source definition, or a server URL. Copy either
`templates/text` or `templates/comic` into a separate plugin project, install this
SDK archive, and bundle `worker.ts` as an ES2022 classic Worker (IIFE). The comic
example asks for an image URL; the host still requires domain authorization.

### Project tools

The SDK includes the `readest-plugin` command. With the SDK installed in a tooling
project, create an independent plugin with either template:

```sh
readest-plugin init ../my-novel --template text --sdk /path/to/readest-plugin-sdk.tgz
cd ../my-novel
npm install
npm run check
npm run build
npm run serve
```

Use `--template comic` for the image provider. Omit `--sdk` when the matching SDK
version is available from your package registry. `check` validates the manifest
and verifies that the Worker can bundle without application imports. The generated
project also runs TypeScript in strict mode.

`build --dev` signs with a local Ed25519 key in `.local/` and creates the plugin,
`repo.json` and `index.json` under `dist/`. Keep `.local/` out of version control.
`serve` exposes only repository JSON and plugin archives on loopback port 4781;
import its displayed repository URL and review the development signer in Readest.
Use `readest-plugin build --key /private/signing.pem` to sign with a release key.
It never uploads the archive or publishes a release. `--project`, `--out` and
`--port` select the input project, output directory and local server port.

Use `defineContentProvider` to implement `getWork`, `getChapters`,
`resolveChapter`, and `resolveResource`. Add `search`, `explore`, `authenticate`,
and `checkUpdates` only when declaring those capabilities in the manifest.
`definePlugin({manifest, contentProviders: [...] }).start()` validates the
registrations and installs the worker RPC server. Missing operations produce
`OPERATION_UNAVAILABLE`; throw `new PluginError(message, code)` for other
structured failures. Cancelled operations receive an aborted `host.signal`.

Each callback receives its typed operation input and a request-scoped host:

- `host.source`: public configuration, opaque instance lease, optional imported
  definition, and opaque secret handles.
- `host.http(request)`: HTTP(S) URL, method, optional body/JSON, headers and secret
  bindings; returns status, final URL, headers and bytes. Decode bytes explicitly
  with `TextDecoder` for the source's encoding. Cookie response headers are owned
  by the host cookie jar.
- `host.storage.get/set/delete` and `host.cookies.get/set`: isolated instance
  state. Values from different source instances are never shared implicitly.
- `host.interaction`: declarative form/message requests, subject to permission.
- `host.progress(stage, completed, total?)`: progress for the active operation.

The facade binds every call to the host-issued instance lease. Public manifest
permissions are upper bounds; the user still grants domains and optional
capabilities per instance. Only signed compatibility runtime packages need
`wasm: true`; imported raw source text remains untrusted data.

Search, discovery and directory pagination return `{items, nextCursor?}`. Omit
`nextCursor` only after successful completion. Work and chapter IDs must survive
title changes, reordering and URL token rotation. Use stable resource IDs as well.
HTML chapters return `{kind: 'html', html, resources?}` and image chapters return
`{kind: 'pages', pages}`. HTML references resources by the keys in `resources`;
the host sanitizes content and loads the referenced resources through its broker.
Resource references may carry opaque JSON `data`; `resolveResource` converts one
to a fresh authorized HTTP(S) descriptor. Never place credentials in metadata.

A compatibility plugin additionally declares `sourceFormats` and implements
`inspect({format, content, filename?}, host)`. It returns raw definitions and
optional diagnostics without initializing network access. Suggested `origins`
are displayed for authorization; importing never grants them automatically.

## Independent contract tests

Import `createContentTestHost` from `@readest/plugin-sdk/testing` to exercise a
provider with in-memory instance storage and fixed HTTP responses. The helper
never contacts the network; unexpected requests and unconsumed fixtures fail.
Use `parsePluginOperationResult` to validate each provider result against the
same contract used by the reader. Testkit mocks are not a production sandbox.

```ts
const harness = createContentTestHost(
  { instance: 'test-lease', providerId: provider.id, config: {} },
  [{ url: 'https://example.com/search', response: {
    status: 200, headers: {}, bytes: new TextEncoder().encode('{"items":[]}'),
  }}],
);
const result = await provider.search!({ query: 'example' }, harness.host);
parsePluginOperationResult('source.search', result);
harness.assertComplete();
```

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
`protocolVersion: 2`, `entry: "worker.js"`, `pluginApi: {min: 4, max: 4}` for content
providers (existing dictionary/library plugins can keep API 2),
permissions, contribution IDs, formats and declarative connection settings.
Supported setting types are `text`, `secret`, `boolean`, `select` and `number`.

The signature signs UTF-8 JSON `{format:1,files:[...]}`. Sort the file inventory
by ASCII path; each entry has `path`, byte `size`, and lowercase SHA-256. Include
every file except `signature.json`. The signature record includes algorithm
`Ed25519`, the base64 raw 32-byte public key, the inventory and base64 signature.
The signer fingerprint is SHA-256 of the raw public key.

Archive limits are 16 MiB compressed, 32 MiB expanded and 256 signed files.
Absolute paths, traversal, duplicate/case-colliding paths, Windows device names,
encrypted entries and unsigned additions are rejected. `readest.*` IDs belong to
bundled plugins. The SDK CLI applies these size limits before writing an archive.

To develop a plugin of your own, initialize a template, change its manifest
ID, and keep `worker.ts` as the entry point. Import only this SDK. Place signed
assets in `resources/`; read them with `readBundledResource('resources/name')`.

```sh
readest-plugin check
readest-plugin build --key /private/signing.pem --out ./my-repository
```

The SDK tarball includes TypeScript sources for bundlers such as esbuild. Install
it from a local tarball in a separate project with `pnpm add /path/to/readest-plugin-sdk.tgz`.
The example packages require no host source files or runtime plugin dependencies.


## API 4 management and configuration

RPC remains version 2. Hosts accept existing API 2/3 packages; new management
contributions require `pluginApi: {min: 4, max: 4}`. Do not claim API 3 support
when using API 4 manifest fields or operations.

Declare `contributions.managementPages` with an ID, title, owned `providerIds`
and `sections`: `sourceInstances`, `sourceSubscriptions`, `settings`,
`information`. The host renders these sections with its normal settings controls.
Pages cannot inject HTML, navigate arbitrary routes or name arbitrary RPC methods.

Static provider `settings` configure one source instance. Optional
`contributions.settings` configure the plugin as a whole. They are separate
namespaces; credentials are never inherited by a source. Runtime callbacks read
ordinary values from `host.source.config` and `host.source.pluginConfig`.
`default`, `description`, `options` and `private` supplement a setting field.
A secret field is always private; `private: true` also encrypts ordinary text
inputs without masking the editing control.

A provider declaring `capabilities.describe` implements `describe({}, host)`.
It returns `{settings, actions, authentication}`. Authentication is `{kind:'none'}`,
`{kind:'form', fields}` or `{kind:'unsupported', reason}`. Description must be pure:
no network, state mutation, credential access or initialization requests.
Compatibility adapters evaluate metadata in a bounded VM without `init()`.

A provider declaring `capabilities.settingActions` implements
`runSettingAction({actionId}, host)`. Only IDs returned by its description are
accepted. Return `{completed:true, message?}`. Keep action labels specific and
report unsupported capabilities instead of returning successful empty data.

`permissions.secrets` authorizes opaque credential injection through `host.http`.
Reading a private setting requires the additional `permissions.secretValues`
and user authorization. Use `await host.settings.readPrivate(keys)` for the
current instance or `await host.settings.readPrivate(keys, 'plugin')` for the
owning plugin. The result is `{values}`; requested keys must be declared/saved
in that scope. Raw values must never be placed in work metadata, diagnostics,
exports or shared caches. Changing settings revokes that scope's active runtime.
Keeping a masked field blank preserves its value; clearing is an explicit action.

Source-list imports return `references` without fetching or executing the listed
sources. Reference entries may include `version` and `description`. The host
persists successful list snapshots, refreshes only on request, and retains the
previous snapshot on failure. Updating a source preserves its instance identity,
permissions, settings, books and downloaded chapters.

`anySignal(...signals)` works without the newer `AbortSignal.any` browser API.
Always invoke its returned `cleanup()` in a `finally` block after the operation.


Input validation callbacks declare `capabilities.validateSettings` and implement
`validateSettings({values}, host) => {fieldErrors}`. This operation has the same
restricted host permissions as description. Return field keys with safe errors;
never echo private values. Compatibility regexes run inside the bounded VM.

API 4 errors may carry `diagnostic: {stage?, status?, retryable?}`. Stages use the
SDK enum; HTTP statuses are 100–599. No URLs, raw response data or credentials
are permitted in this diagnostic object. API 2/3 host replies retain their
original two-field error shape.

Native network resolution uses the system resolver and supports DNS64 with
RFC 6052/7050 validation. WebKit tests do not replace iOS device validation;
network behavior still needs an iOS device report before claiming device coverage.
