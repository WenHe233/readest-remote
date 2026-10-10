# Windows V2 verification record

Verified on Windows x64 with Node 24.20, pnpm 11.1.1, Rust 1.95 and Docker 29.
Date: 2026-10-10. This record distinguishes automated/native results from browser
observations and remaining acceptance limits.

## Baseline and implementation

- Branch: `feat/external-plugins-v2`, based on upstream `v0.12.12`,
  `fd9f0c0645b8350ed83bc02ddefbbfc598115d33`.
- V1 remains on `feat/kavita-v1` (`8fde508e7`) as an algorithm/test reference.
- Product: Readest Remote V2. Application ID: `io.github.wenhe233.readestremote.v2`.
  Binary: `readest-remote-v2.exe`. Scheme: `readest-remote-v2`.
- No V1 migration, public release, or official-cloud schema deployment.
- Pinned submodules and lockfile retained. The Foliate PDF changes are a
  reproducible patch applied by `scripts/apply-vendor-patches.mjs` during prepare;
  its submodule commit is unchanged.

The implementation reuses upstream RPC validation/cancellation, Source/SQL
brokers, dictionary operations, Foliate/RemoteFile readers, OPDS page streaming,
settings primitives and encrypted Replica middleware. The SDK has no host
imports. Both plugins depend only on the SDK. No Kavita/Komga branches were added
to the core reader.

## Container fixtures

| Server | Version | Pinned image digest | Result |
| --- | --- | --- | --- |
| Kavita | 0.9.0.2 | `sha256:880a8feff0833e860575f8e08788e4b4f59f8659afd17206566aae88a525130d` | 672 chapters: 665 EPUB, 6 CBZ, 1 PDF |
| Komga | 1.28.1 | `sha256:d8f772dce7b3dcd8baa0ce7481bd890e68446065ab6c8eb2cb5b24df62fb3c4f` | 675 books: 668 EPUB, 6 CBZ, 1 PDF |

The sibling `kavita-test` books and manga directories are mounted read-only.
Kavita groups six EPUB files into three alternate-edition chapters. The plugin
keeps those chapters and opens the first edition, matching the server reader.
Private container volumes, credentials and the Ed25519 private key are in the
sibling `.v2-local` directory and are not tracked or included in the delivery.

## Automated and native checks

| Check | Result/evidence |
| --- | --- |
| Browser suite | 89 files passed; 681 tests passed, 1 skipped. Includes Yomitan import/query and opaque Worker isolation. `browser-tests-verified.log` |
| Full unit suite | 1102 files passed, 5 skipped; 12,940 tests passed, 19 skipped. Latest follow-up: `unit-tests-actions-final.log`, 978.88 seconds, no failures. |
| Independent SDK | Tarball installed outside the host repository; reference plugin built using only the SDK and ran successfully in native WebView2. `sdk-independent-build.log`, `native-lifecycle-final.log` |
| Native isolation | 2 checks passed in WebView2: denied data-URL fetch (no DNS/CORS false positive), denied eval, denied host IndexedDB, no Tauri/DOM access, termination. `native-isolation-final.log` |
| Package verification | 6 tests passed: Ed25519, changed/unsigned bytes, paths, case aliases, reserved IDs and API compatibility. |
| Lifecycle and cache | Real signed workers; consent, updates, signer conflicts, rollback, corruption on restart, revocation, uninstall/reinstall continuity and persistent cache revision/offline-miss checks passed. |
| Management UI | English install/permission/connection flow and Chinese electronic-ink layout passed; screenshots saved under `verification/`. |
| Static repository | Native import, relative URLs, package identity/hash verification and installation passed. `native-repository-verified.log` |
| Native content | Both plugins opened/rendered/sought EPUB, CBZ and PDF, authenticated covers, downloaded originals and reopened offline. Native PDF capability restored for downloaded Komga PDFs. `native-content-verified.log` |
| Native faults/progress | Invalid credentials preserve saved credentials; incomplete scans preserve the shelf; canceled downloads remove temporary files; retry succeeds; real EPUB anchors round-trip through each server; offline progress queues persist and retry. `native-faults-verified.log` |
| Large EPUBs | Both large-book paths and Kavita's multi-file chapter passed. `native-large-verified.log` |
| Self-hosted API | Actual API and PostgreSQL migration tested: ciphertext round-trip, wrong passphrase, plaintext rejection, merge and deletion. `cloud-tests.log` |
| Two Windows profiles | Separate binaries/configurations `.verification.a` and `.verification.b`: native vault/WebView isolation, encrypted connection transfer, device-local overrides and execution approval, decrypt failure, merge, deletion and restart. Three phases passed (`cloud-native-a`, `cloud-native-b`, `cloud-native-a-verify`). |
| TypeScript / Biome | Type check and host/SDK lint passed; final check logs accompany the delivery. |
| Rust | 181 tests passed; formatting and Clippy passed. Final packaging checks accompany the delivery. |
| Upstream Windows native suite | 6 files; 118 passed, 1 skipped. Unix-only HOME/PATH assumptions in two smoke assertions were corrected. `native-upstream-verified.log` |
| Windows CI native entry point | Upstream 118 and plugin isolation/lifecycle/cache 7 passed using `test-windows.ps1 -ReuseApp`. `ci-native-harness.log` |
| Complete Windows CI startup | Fresh CI application/profile and private Next output directory: 7 native files, 119 passed/1 skipped, followed by 7 plugin checks; owned processes stopped automatically. `ci-native-startup-verified.log` |
| Portable data isolation | Real Windows filesystem test preserves adjacent V1 settings, creates V2's portable book root, and retains its settings root after a library-directory change. `native-portable-verified.log` |
| Static Web | Production export passed after reusing V1's share-metadata static guard. Manifest identity, `/s`, service worker and icons verified. `ci-web-build-verified.log` |
| CI plugin browser lane | 4 files, 9 passed against plugins rebuilt from the independently extracted SDK examples. `ci-browser-plugins.log` |
| Actions tooling | `actionlint` passed; 3 release-tool tests passed (complete matrix, deployment variables, signing identity). The SDK/examples archive rebuilt both plugins outside the host repository. |

Browser/native lanes use separate Vite caches. Cold browser startup is allowed
three minutes; individual test assertions retain their own deadlines. Native test
permissions are static capability files selected only by the WebDriver CLI
configuration. Production configuration includes only normal app capabilities.

## Measured first-screen transfer

Measurements count response body bytes for content resources, excluding server
metadata API calls. Cache was cleared before each measurement. Values are bytes,
not estimates derived from file size. Original downloads were tested separately.

| Path | Original file | First screen | Content requests |
| --- | ---: | ---: | ---: |
| Kavita large EPUB | 46,575,867 | 3,059,963 | 24 |
| Komga large EPUB | 46,575,867 | 2,532,798 | 5 |
| Kavita alternate-edition EPUB | 24,289,581 | 958,765 | 8 |
| Kavita PDF | 18,911,058 | 1,740,626 | See raw measurement |
| Komga online PDF | 18,911,058 | 688,588 | See raw measurement |
| Kavita CBZ | 141,486,506 | 2,707,354 | See raw measurement |
| Komga CBZ | 141,486,506 | 2,003,057 | See raw measurement |

The PDF first-screen test is range-based. Seeking can require more of a PDF's
page tree; this fixture's subsequent seek eventually read the whole PDF. The raw
`kavita-streaming.json` retains both first-screen and post-seek byte counts.
Komga online PDF pages are raster images; original download restores native PDF
text/search features.

The pinned PDF.js worker is built with a narrow change: remote `disableAutoFetch`
loads defer the eager last-page tree walk. Local PDF validation remains upstream.
The host caps remote page counts and each requested page is still parsed by
PDF.js. The Foliate patch also bounds range cancellation and awaits destruction
before renaming a validated temporary file. The Tauri HTTP patch fixes stale
abort listeners/resource cancellation; its regression tests pass.

## Observed server-reader interoperability

- Kavita EPUB: its web reader saved page 4 (the “阅读之前” heading). A native
  Windows test restored the exact `id(...)` XPath and pushed the next section.
  Reopening the web reader displayed page 5 (“午夜文库”). This exposed and fixed
  generic element-XPath handling. `native-web-progress.log` passed.
- Komga PDF: its web reader restored the native position at page 3, advanced to
  page 4, and exited. The native reader restored page 4 and pushed page 5.
  Reopening the web reader displayed page 5. `native-web-pdf-progress.log` passed.
- Komga EPUB: the web reader displayed the plugin-saved chapter. Loading the next
  chapter was blocked by the in-app browser with “此页面已被 ChatGPT 屏蔽”. That
  specific browser alternation remains unverified. The real Progression API and
  native EPUB anchor round-trip tests passed; this browser block was not bypassed.

## Delivery and limits

The delivery directory contains the Windows x64 NSIS installer, two signed
`.readest-plugin` packages, static repository/import file, SDK tarball, local
repository server, checksums and this record. Build/signing tools and full SDK
examples are in the branch. The plugin signer fingerprint is
`53bd64d1d5c13cd5010e0e46dd1e521d3a296fa41c6e7ce1767266890ba2092e`.

The local cloud fixture uses PostgreSQL, Kong, GoTrue and PostgREST with migration
026. Quay denied the fixture MinIO image pull (401), so metadata-only encrypted
replicas were tested without object storage. External originals/cache are not
uploaded. This does not claim validation of binary cloud uploads.

The delivered build points at the local self-hosted test services (auth gateway
18000, Readest API 3003). Rebuild with the deployment variables in SELF_HOSTING.md
for another Readest server. Kavita/Komga URLs are configured in the application.

Final Windows NSIS build and re-bundle succeeded. The AMD64 release executable
started successfully with product name **Readest Remote V2** and version
**0.12.12**, and registered the V2 URL scheme to the release executable. This was
initially an executable startup smoke test. The follow-up acceptance completed
the NSIS wizard in current-user mode, started the installed application, and
opened Settings → Plugins. The new shelf was empty and Yomitan remained listed.
The V2 protocol and both plugin file associations registered successfully;
the original Readest and V1 protocol registrations were unchanged. The installed
binary matches the build after normalizing Tauri's three-byte NSIS bundle marker.
The Windows firewall prompt was handled by the user. The updated final installer
also completed an Add/Reinstall cycle; the installed binary was checked against
the newly compiled release using the same marker normalization.
The thumbnail extension has an independent CLSID and cache directory; its Clippy
check passed and its tests reported 6 passed, 1 ignored. Main Rust tests reported
181 passed. Latest full unit run: 12,940 passed, 19 skipped; no failures.

Installer SHA-256: `f6c3780efa4320de0b6163d6f140e367202e393c4fe2adda5ed1d2225f13325b`.
Raw logs and screenshots remain in `.v2-artifacts`.

## Full-platform Actions follow-up

The user requested the full V1 matrix for CI, with local runtime acceptance still
on Windows x64. The workflow checks 19 deliverables, adds the signed plugin
source, SDK and runnable examples, and keeps upstream 0.12.12's Linux CEF build.
Android/Apple identity settings and shared credential/app-group namespaces were
updated for V2. Git attributes now enforce the LF format expected by Biome on
Windows; committed CRLF fixtures were not rewritten.

Manual runs produce Actions artifacts. Only an explicitly pushed
`remote-v2-v<version>` tag publishes a Release after all gates pass. The obsolete
upstream deployment workflows are removed, following V1. See `CI.md` for the
public self-hosted variables, plugin key and Android signing secrets required.
No workflow was dispatched, branch pushed, tag created or public release made
during this local follow-up. The non-Windows jobs require hosted runners; their
execution has not been claimed as local acceptance.

After the passing native runs, the portable test's legacy-directory sentinel was
restricted to its own temporary directory. An additional repetition of that one
test was rejected by automatic approval with `blocked by policy`, without a
specific reason, before the command ran. This changed test data only; the
application implementation was unchanged from the passing native tests.
