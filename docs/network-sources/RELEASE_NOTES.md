# Readest Remote X 0.12.12-x2

The experimental app is now displayed as **Readest Remote X** on desktop, Android,
iOS and Web. The application identifier, data profile and deep-link schemes stay
the same, so this update keeps existing experimental installations and data.
Windows keeps the existing experimental installer registry keys and reuses its
previous installation directory. The installer updates its displayed name and
only renames old shortcuts when their target is the experimental executable.

This update brings network sources into the library search and the existing Foliate reader.

- Select local books, synchronized library catalogs and individual content sources in the
  library search dropdown. Website searches start on submission. Full-text search reads only
  locally available text, including completed novel downloads.
- The library view menu includes a saved, multi-select library filter. It can display local
  books, specific libraries or sources together; search scopes remain independent.
- Source search results, details and saved books share authenticated cover loading. Saved
  covers remain available offline.
- Network comics use Readest's fixed-layout reader, including touch navigation, continuous
  scrolling, zoom and the existing reading controls. Chapters load on demand. Unknown book
  totals display chapter and current-chapter page positions. Image prefetch supports 0/2/5/10.
- Plugin API 4 adds declarative management pages and dynamic settings. API 2/3 packages and
  protocol 2 remain supported. Venera list subscriptions persist independently of installed
  sources, and API keys are encrypted per instance. Existing installations must upgrade the
  Legado/Venera compatibility packages to 0.3.0-x1; new plugin development uses SDK 0.3.0-x1.
- Downloads persist each verified resource and can pause, resume or recover after restart.
  The storage panel separates temporary cache, incomplete downloads and completed downloads.
- Compatibility engines share cancellation helpers for older WebViews. Native source HTTP
  reports bounded diagnostics and follows the system proxy/VPN for authorized hostnames,
  including Fake-IP. Explicit private-address URLs still need separate authorization.
  Apple PAC scripts currently report an unsupported proxy configuration.

The application retains its experimental identity and isolated data. WebView-only authentication
and browser networking restrictions remain as described in COMPATIBILITY.md.

## x2 verification and distribution

The proxy/filter/rename follow-up passed 13,131 application tests (17 skipped), 207 Rust tests
(one live test run separately), TypeScript/Biome checks and release-tool tests. The original
jsDelivr list downloads on a Windows Fake-IP network. The new menu also passed two WebKit
mobile/e-ink tests in addition to its Chromium coverage. The Windows release build passed;
iOS Fake-IP and the complete remote platform matrix remain required verification.

Earlier x2 checks passed: Chromium 710 tests (1 skipped), WebView2 130 tests (1 skipped), and Rust
197 tests (1 ignored). Two Windows builds and the final Web build passed; the final Web build
covers the last frontend-only storage-quota fix. The final whole-app unit suite passed 13,119
tests across 1,133 files, with 17 tests / 5 files skipped. TypeScript/Biome lint and repository
format checks passed.

SDK 0.3.0-x1 is pinned to `7e5ddaa60b23e99cb6ac8c0cc848ace83e5c8d79`. Its canonical archive
SHA-256 is `e3fa8d04c1c1da11515906b8fce244a7dc5dc4685bd5ddc89aeeb25e966aa344`.

The next application workflow run produces test packages with `publish=false`. Publish the
application x2 prerelease only after iOS 17.0 cellular/IPv6-only device verification passes.
The independent SDK/compatibility prerelease `v0.3.0-x1` is published and pinned by commit and
asset hashes. Production-signed packages passed Chromium/WebKit tests without AbortSignal.any;
remote live acceptance passed three Venera and three Legado sources.

The user confirmed that the original jsDelivr list downloads after switching ClashMi to
redir-host. This update removes the DNS-answer rejection that conflicts with Fake-IP,
using the compatibility-first network policy selected by the user. It keeps hostname grants,
TLS, redirect checks and explicit private-address checks. Final resolved IPs for authorized
DNS names are entrusted to the system network. The new package uses internal build 12012103;
Fake-IP on the user's iOS device still requires verification before prerelease publication.

## x1 introduction

This experimental channel introduces a native content plugin API and optional Legado/Venera
compatibility adapters. It installs separately from Readest Remote and uses a separate
profile and `readest-remote-x` URL scheme.

The content workflow includes source instances and origin grants, search, chapter directories,
reading, library collection and chapter downloads. Plugin API 2 dictionary/library packages
remain supported; native content plugins use API 3 without either compatibility engine.

See COMPATIBILITY.md for the specific validated sources and unsupported operations. Web
clients remain subject to browser networking restrictions. Online-source cloud sync and
automatic source switching are not included. The x1 release candidate must pass all stated
compatibility and platform gates before publication.
