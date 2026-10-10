# V2 GitHub Actions

`release.yml` adapts the full `feat/kavita-v1` matrix to the upstream 0.12.12
build system. The application, mobile app groups, credential namespaces and
primary protocol use the V2 identity. Linux retains upstream's CEF runtime and
revision-pinned bundler; the V1 WebKitGTK release command is not used.

## Triggers and outputs

- **V2 checks** runs on pushes and pull requests to `main` and
  `feat/external-plugins-v2`, on manual dispatch, and as the release test gate.
- **Release Readest Remote V2** can be dispatched manually to build downloadable
  Actions artifacts. A manual run does not create a GitHub Release.
- Pushing a tag named `remote-v2-v<package version>` runs the same pipeline and
  publishes only after every build and test gate succeeds. For the current
  version the tag is `remote-v2-v0.12.12`. No tag or public release is created
  by the local implementation/verification work.

The final `readest-remote-v2-<version>` artifact contains 19 payloads:

| Platform/component | Artifacts |
| --- | --- |
| Windows x64, ARM64 | NSIS installer and portable executable for each |
| Linux x64, ARM64 | CEF AppImage and DEB for each |
| macOS | Unsigned universal DMG |
| Android | Signed universal and ARM64 APKs |
| iOS | Unsigned ARM64 IPA, with the V1 icon preparation step |
| Web and companions | Static Web, browser extension, Calibre and KOReader ZIPs |
| External plugins | Signed static source, SDK tarball and runnable SDK examples ZIP |

The source ZIP contains two independently installable `.readest-plugin` files,
`repo.json`, `index.json` and a localhost `.readest-repo` import file. Extract it
and serve it with `scripts/serve-plugin-repository.mjs`. The examples ZIP includes
the SDK tarball, reference source, and build/signing and repository-serving tools.
Run `npm install` in its root before building. No signing key is packaged.

The aggregate job checks the exact matrix, rejects missing/empty artifacts,
unexpected files and updater artifacts, and generates `SHA256SUMS.txt`.
Only the final tag publishing job receives `contents: write`. The upstream
R2, Vercel, nightly, Docker-publishing and Nix-maintenance workflows removed in
V1 are also removed here.

## Repository configuration

These **Actions variables** are required before a release build:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | Your V2 self-hosted Readest API base URL |
| `NEXT_PUBLIC_SUPABASE_URL` | Your self-hosted Supabase/Kong URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Its public anonymous/publishable key |
| `READEST_PLUGIN_SIGNER_SHA256` | SHA-256 fingerprint of your Ed25519 public key |

Do not use a Supabase service-role/secret key in a frontend variable. The setup
script rejects those keys and URLs containing credentials. Cloud variables are
compiled into each client; they are not the Kavita/Komga server addresses, which
users configure in Settings. See [SELF_HOSTING.md](SELF_HOSTING.md).

Windows portable builds use a `ReadestRemoteV2` directory beside the executable.
They ignore a neighboring V1 `settings.json`; choosing a different book folder
still leaves V2's settings in its own directory.

These **Actions secrets** are used only by their signing jobs:

| Secret | Value |
| --- | --- |
| `READEST_PLUGIN_SIGNING_KEY_PEM` | Ed25519 private key in PKCS#8 PEM form |
| `ANDROID_RELEASE_KEYSTORE_BASE64` | Same keystore secret format as V1 |
| `ANDROID_RELEASE_STORE_PASSWORD` | Keystore password |
| `ANDROID_RELEASE_KEY_ALIAS` | Signing alias |
| `ANDROID_RELEASE_KEY_PASSWORD` | Alias password |
| `ANDROID_RELEASE_CERT_SHA256` | Expected Android signing certificate fingerprint |

The plugin job checks the key type and fingerprint before signing. Keep the same
key for plugin updates. It writes the PEM only to a temporary directory and
removes it in `finally`; artifacts contain the public key and signatures only.
Do not upload the local `.v2-local` fixture directory.

## Verification lanes

PR checks need no signing secrets or real book servers. They use disposable
plugin signers, install the SDK tarball into a separate consumer project, and
test the resulting workers. Windows runs type/lint/format checks, the complete
unit and Chromium suites, plugin UI/lifecycle/cache/isolation checks, Rust and
thumbnail checks, and native WebView2 tests. Companion tests run on Linux.

`scripts/ci/test-windows.ps1` starts its own Next/Tauri processes and stops only
those processes. It refuses occupied ports. `-ReuseApp` is for an already
running, explicitly selected local test app on WebDriver port 4445.

Real Kavita/Komga Docker and two-profile encrypted cloud tests remain the local
acceptance lane. CI's server-free worker tests do not claim those results.
`STATUS.md` records the actual local verification; non-Windows runtime acceptance
is not claimed merely because the build matrix is configured.

The release gate uses GitHub's [reusable workflow mechanism](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
so manual/tag builds run the same checks as pull requests.
