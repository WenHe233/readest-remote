# Readest Remote V2

This branch starts at upstream Readest `v0.12.12`
(`fd9f0c0645b8350ed83bc02ddefbbfc598115d33`). The V1 branch remains a reference.
The Windows application ID is `io.github.wenhe233.readestremote.v2` and its
deep-link scheme is `readest-remote-v2`. Configure connections again on first use.

## Build and install

Use the repository's pinned Node/pnpm dependencies, Rust toolchain, Windows MSVC
build tools and WebView2. Initialize the submodules listed in `.gitmodules`;
`gstack` is not needed to build the application.

```powershell
pnpm install --frozen-lockfile
pnpm --filter @readest/readest-app setup-vendors
node scripts/build-plugins.mjs --dev
pnpm --filter @readest/readest-app build
pnpm --filter @readest/readest-app exec tauri build --target x86_64-pc-windows-msvc --bundles nsis
```

The signing tool writes packages, `repo.json`, `index.json` and an import file to
`.v2-artifacts/repository`. `--dev` creates a local Ed25519 key in the sibling
`.v2-local` directory, outside Git. Keep that key to sign updates. For your own
signer, pass `--key C:/private/plugin-signing-key.pem`; never commit the key.
`--version`, `--channel`, `--out` and `--url` override the release metadata.

In Settings → Plugins, choose **Install from file** and open a `.readest-plugin`.
Review the signer fingerprint and requested permissions before installing.
For a local static source:

```powershell
node scripts/serve-plugin-repository.mjs .v2-artifacts/repository --port 4781
```

Import `http://127.0.0.1:4781/repo.json`, the generated `.readest-repo` file, or
`readest-remote-v2://plugins/add-repository?url=http%3A%2F%2F127.0.0.1%3A4781%2Frepo.json`.
Stable is the default channel. Refresh the source to discover releases; updates
require approval. The previous installed version remains available for rollback.
The signer association remains after uninstall, so retained dictionaries and
connections cannot be claimed by another signer using the same plugin ID.

## Connections and reading

Install Kavita or Komga, select **Add connection**, enter the server URL and API
key, test the connection, and choose libraries. Server URLs can include a reverse
proxy path. A device URL override and an invalid-certificate option remain local.
Only use the latter for a server whose certificate you independently trust.

Kavita uses its Auth Key API. Komga uses the API key created in its user settings.
The tested server versions are Kavita 0.9.0.2 and Komga 1.28.1. Credentials remain
in the host vault; workers receive opaque handles. Covers use authenticated
requests and local files, so keys do not appear in image URLs.

EPUB content is fetched on demand. Kavita uses strict HTTP ranges; Komga uses its
EPUB resource endpoint. Comics use server page images. Kavita PDFs use the native
PDF reader with authenticated ranges. Komga online PDFs use page images; download
the original PDF to enable native text selection and search.

If Kavita groups alternate EPUB/PDF editions in one chapter, the plugin follows
Kavita's own reader and opens the chapter's first file. The chapter remains the
unit of identity and server progress. The test library contains three such EPUB
chapters; its 675 files appear as 672 Kavita chapters and 675 Komga books.

The streaming cache has a 1 GiB budget and 128 KiB range blocks. Cached fragments
do not mean the book is fully offline. **Download for offline reading** saves and
validates the original file. Complete offline books use upstream local readers
and survive disabling or uninstalling their plugin. Cache clearing and removing
an offline copy are explicit operations; neither deletes annotations.

External reading progress belongs to its source plugin. Readest Cloud and KOSync
do not simultaneously write the external book's reading position. Annotations
continue through the existing host services. Book originals and streaming cache
are excluded from automatic cloud file uploads.

## Development and verification

The SDK is in [`packages/plugin-sdk`](../../packages/plugin-sdk/README.md).
The two plugins import only that package. The build tool rejects imports from
`apps/readest-app/src`. All plugin dependencies are bundled into a single Worker.
Use signed local packages when testing the installed runtime.

```powershell
pnpm --filter @readest/readest-app lint
pnpm --filter @readest/readest-app test --run --maxWorkers=4
pnpm --filter @readest/readest-app test:browser
pnpm --filter @readest/readest-app exec vitest run --config vitest.plugins.config.mts
cargo fmt -p Readest --check
cargo clippy -p Readest --no-deps -- -D warnings
cargo test -p Readest --lib
```

The optional real-server tests require local fixture credentials outside Git and
`READEST_PLUGIN_INTEGRATION=1`. The native plugin test lane additionally uses the
upstream WebDriver feature, `READEST_NATIVE_TEST=1`, and a running debug desktop
application. Its extra capabilities are selected in the test CLI configuration,
not in the shipped application configuration.
Do not distribute a build with WebDriver enabled.

[`STATUS.md`](STATUS.md) records actual checks and remaining acceptance work.
[`SELF_HOSTING.md`](SELF_HOSTING.md) describes encrypted connection replicas.
