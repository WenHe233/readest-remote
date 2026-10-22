# Readest Remote GitHub Actions

The fork follows the upstream v0.12.12 build system and the V1 platform matrix.
The current release is `0.12.12-r2` (tag `v0.12.12-r2`). Android versionCode and
Apple bundleVersion are `12012002`; the application identifier remains
`io.github.wenhe233.readestremote` and the protocol remains `readest-remote`.

## Builds and publication

Manual runs produce Actions artifacts. Pushing `v<package version>` runs the
same checks and publishes a GitHub Release only after every required job passes.
No upstream deployment, telemetry upload or updater publication is configured.

The default branch also exposes **Experimental Release**. Run it from the default
branch and select `exp/network-sources` (the default) or another `exp/` branch.
The workflow resolves that branch once to a commit SHA, then passes the SHA to
the shared release matrix and every reusable check. The package version must
already be committed as `<base>-xN`, with `N` a positive integer, and the Tauri
configuration must use the experimental app identity. It never bumps or commits
versions while building. Stable tag runs exclude `-xN` tags.

Experimental publication creates a draft only after checks and all 19 payloads
pass. It verifies the uploaded asset digests before publishing with
`prerelease=true` and `make_latest=false`. An existing published release or a tag
pointing at another commit is rejected. Use **Re-run failed jobs** after an upload
failure: a matching draft can resume with the original artifact bytes; the
workflow never overwrites existing assets. Rebuilding different bytes requires
the next experimental version. Experimental runs are serialized.

Each aggregate includes `RELEASE-METADATA.json` with the source SHA, application
identity, internal build number and complete plugin release lock. Experimental
builds also require `docs/network-sources/COMPATIBILITY.md` and `RELEASE_NOTES.md`
from the same source commit, and attach them to the release. Checksums cover all
payloads and these supporting documents. The release identifier, display name
and binary name come from the checked-out config, including platform artifact
inspection, so experimental and stable installers can use separate identities.

Release-branch pushes do not start a separate checks workflow. Push the version
tag directly after local validation; the release workflow runs the complete
checks alongside platform builds and waits for both before publication. Checks
also remain available for pull requests, main-branch pushes and manual runs.

The aggregate artifact checks exactly 19 payloads:

| Platform | Outputs |
| --- | --- |
| Windows x64 and ARM64 | NSIS installer and portable executable |
| Linux x64 and ARM64 | CEF AppImage and DEB |
| macOS | Unsigned universal DMG |
| Android | Signed universal and ARM64 APK |
| iOS | Unsigned ARM64 IPA |
| Web and companions | Static Web, browser extension, Calibre and KOReader ZIPs |
| Plugins | Signed source ZIP, SDK tarball and examples ZIP |

The plugin outputs come from the independent
[readest-remote-plugins repository](https://github.com/WenHe233/readest-remote-plugins).
`external-plugins.lock.json` pins the source commit, public signer and release
asset checksums. Host CI uses disposable signing keys for worker tests and never
needs the production plugin key. SDK consumers are built outside the host.

Plugin release filenames may carry their own versions. CI derives the three
asset roles from the lock's pinned filenames. A lock can declare a `plugins`
array with each plugin's `id`, `version`, optional `fingerprint` and optional
`channel`; absent fingerprints inherit the lock's signer. The legacy lock without
that array continues to require Kavita and Komga 0.1.1. Compatibility adapters can
therefore ship in an independent experimental plugin release without changing
the stable lock or the application's 19-payload matrix.

## Repository configuration

Readest Cloud is disabled in this release. No API/Supabase repository variables
are required. `scripts/ci/configure-build.mjs` writes a cloud-disabled frontend;
`--test` selects isolated test endpoints and `--cloud` explicitly enables a
self-hosted build with the three deployment variables in SELF_HOSTING.md.

The existing V1 Android Secrets remain required:

- `ANDROID_RELEASE_KEYSTORE_BASE64`
- `ANDROID_RELEASE_STORE_PASSWORD`
- `ANDROID_RELEASE_KEY_ALIAS`
- `ANDROID_RELEASE_KEY_PASSWORD`
- `ANDROID_RELEASE_CERT_SHA256`

The production Ed25519 plugin key and signer variable belong only to the plugin
repository. Local private fixtures, keys, package archives, logs and generated
checkouts must remain ignored. Gitleaks checks unpublished history and the staged
diff; `.gitleaksignore` records exact reviewed upstream false-positive fingerprints.

## Validation

Windows CI runs type checking, lint, formatting, the full unit/browser suites,
Rust and thumbnail checks, and native WebView2 tests. The native harness uses a
separate application identifier and protocol. Native and plugin assertions run
sequentially in one WebDriver session, avoiding stale sessions between Vitest runs. Real library-server tests remain
local, using read-only books fixtures and dedicated Kavita/Komga containers.

Plugin startup is also tested beneath the configured Tauri CSP with an embedded
script hash, matching the production policy that disables inline scripts. The
Chromium suite and focused `vitest.plugin-webkit.config.mts` gate verify startup
and the denial of direct networking, host storage, eval and Tauri access. The
WebKit gate uses native response headers; it omits the web deployment's COOP/COEP
headers, which are not served by Tauri's embedded asset protocol. These browser
engine checks do not claim acceptance on a physical iOS or Android device.

The portable build keeps `settings.json` and the `Readest` books directory beside
the executable, matching V1. WebView cache uses the upstream Windows app-data
location. The
first upgrade backs up old application data before initializing a fresh profile.
See RELEASE_R1.md for recovery and compatibility details.
