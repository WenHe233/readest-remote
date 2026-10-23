# Native content plugin framework

Readest owns package trust, capability registration, source instances, IO, the library,
downloads and rendering. Plugins implement public capabilities. A compatibility plugin
translates an external source format into those same capabilities; no reader code branches
on a compatibility engine's name.

## Interfaces and ownership

- RPC envelope version remains 2. The host accepts plugin API ranges intersecting 2..3.
- API 2 dictionary/library contracts remain supported. API 3 adds content capability version 1.
- `definePlugin` and `defineContentProvider` generate validated RPC handlers; SDK types,
  templates and the testing host can be consumed without application source imports.
- A plugin package is signed code. A provider is a contributed capability. A source
  definition is imported data/code. A source instance is a host-generated identity with
  settings, explicit origin grants, credentials and private storage. Native providers need
  neither an imported definition nor a server URL.
- Imported definitions do not inherit executable-package trust. Inspection has no network,
  storage or interaction capabilities. Origins suggested by an importer require approval.
- Every call is bound to a host-issued lease. Network, Cookie, private storage and interaction
  require both the package permission and the instance grant. A plugin cannot select another
  instance by supplying its identifier.

## Execution and IO

Native providers run in opaque-origin Workers. Compatibility providers bundle QuickJS-WASM
as a signed resource. Only explicitly granted WASM adds `wasm-unsafe-eval` to the worker CSP;
host JavaScript eval, direct fetch, host IndexedDB, DOM and Tauri access remain denied.

Source calls are serial within an instance and cancellable. The host terminates a worker
that exceeds its operation deadline. Compatibility engines additionally bound VM memory,
execution and response sizes. Origin changes and plugin/instance revocation close leases.

The native HTTP command resolves and validates destination addresses, pins the selected
addresses for the request, disables environment proxies and returns redirects to the host.
The host checks every redirect against exact origin grants. It strips credential bindings
before crossing origins and rejects cross-origin redirects of request bodies. Private
addresses require a separate instance grant. Web clients report unsupported browser headers
and opaque redirects rather than pretending those requests succeeded.

Cookies, credentials and plugin private values use separate per-instance AES-GCM records
in IndexedDB; only small encryption keys are held in the host credential vault. This avoids
native credential-record limits for large cookie jars. Source code, user data and complete
downloads are separate records. Disabling/uninstalling executable code does not delete
downloaded chapter bytes, annotations or imported definitions.

## Content and persistence

`Work` and `Chapter` use source IDs, never titles or positions. Directory refreshes commit
only after all cursor pages succeed. Chapters have persistent, never-reused slots; removed
chapters remain as tombstones. Their slots allow old CFIs to resolve after reorder/insertion.
Reading locators also carry chapter identity and text/page anchors.

Text chapters are loaded lazily and sanitized; resources are replaced by host-loaded blobs.
Comics load the current chapter and visible image instead of resolving every chapter at open.
Temporary cache and explicit downloads have distinct lifecycles. A download record is
published only after all chapter resources arrive and receives content/resource digests.
Completed downloads can be read after the adapter is unavailable. Resource bytes are stored
separately from the chapter manifest; directory badges read a small completion record without
loading image data. Explicit removal clears the manifest, completion record and resource bytes.

## Compatibility packages

Legado and Venera live in the independent `readest-remote-plugins` repository and use only
the public SDK. Legado's rule grammar/Java facades and Venera's globals remain in those
packages. Their shared parsing/VM library has no host or UI imports. Engine releases and
user definition updates are independent. See COMPATIBILITY.md for measured coverage.

## Experimental channel

`exp/network-sources` starts from `feat/external-plugins-v2`. The default branch contains the
manual Experimental Release entry and shared build infrastructure. The workflow resolves
the requested experiment branch once, passes its exact SHA to every build/check and only
publishes `v<base>-xN` as a non-latest GitHub Pre-release. Published assets are immutable.

The app identifier, deep-link scheme, credential namespaces, mobile extension groups and
portable directory are separate from Readest Remote. No legacy-profile migration runs.

## Development and release boundary

The SDK includes `readest-plugin init/check/build/serve`, text and comic templates, and an
HTTP replay test host. SDK and compatibility package versions are `0.2.0-x1`; the application
version is `0.12.12-x1`. Existing published library package versions remain unchanged.

The SDK commit, production
compatibility packages and application release lock must be pinned together before a future
release. No placeholder hash may be accepted as a verified release. Build and publication
work resumed on 2026-10-23; the release remains gated by those immutable pins and all checks.
