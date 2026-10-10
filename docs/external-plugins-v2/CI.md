# Readest Remote GitHub Actions

The fork follows the upstream v0.12.12 build system and the V1 platform matrix.
The current release is `0.12.12-r1` (tag `v0.12.12-r1`). Android versionCode and
Apple bundleVersion are `12012001`; the application identifier remains
`io.github.wenhe233.readestremote` and the protocol remains `readest-remote`.

## Builds and publication

Manual runs produce Actions artifacts. Pushing `v<package version>` runs the
same checks and publishes a GitHub Release only after every required job passes.
No upstream deployment, telemetry upload or updater publication is configured.

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

The portable build keeps `settings.json` and the `Readest` books directory beside
the executable, matching V1. WebView cache uses the upstream Windows app-data
location. The
first upgrade backs up old application data before initializing a fresh profile.
See RELEASE_R1.md for recovery and compatibility details.
