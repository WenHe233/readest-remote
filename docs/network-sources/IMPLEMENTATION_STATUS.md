# Local implementation and verification

## x2 local verification complete; device release gate pending (2026-10-24)

The x2 implementation uses API 4 over protocol 2 and keeps API 2/3 packages supported.
SDK source is committed at `7e5ddaa60b23e99cb6ac8c0cc848ace83e5c8d79` (0.3.0-x1).
The canonical SDK archive SHA-256 is
`e3fa8d04c1c1da11515906b8fce244a7dc5dc4685bd5ddc89aeeb25e966aa344`.
The local LF checkout and a separate `git archive` of that commit produce identical npm archives.
The application is 0.12.12-x2 with Android/Apple build number 12012102. Existing installations
must upgrade the Legado/Venera compatibility packages to 0.3.0-x1; plugin developers should
use SDK 0.3.0-x1 for the new management and settings capabilities.

Implemented changes cover unified search, authenticated/persistent covers, plugin management
pages, persisted list subscriptions, encrypted dynamic settings, the existing Foliate comic
reader, image prefetch, accurate chapter/page positions, resumable downloads and cache management.
Full-text search scans completed downloads one chapter at a time and invalidates its snapshots
when downloads change. Source and user-selected cover writes are coordinated per book.

Verified locally:

- Chromium whole browser suite: 710 passed, 1 skipped. Reader cancellation regressions passed
  in Chromium and WebKit, seven tests each.
- WebView2: 130 passed, 1 skipped using the new API 4 development-signed packages. An earlier
  run against the x1 archives reproduced the missing AbortSignal.any failure.
- Compatibility source: 43 passed, 27 optional live cases skipped. Chromium/WebKit signed
  sandbox tests: three each, with AbortSignal.any disabled and delayed HTTP responses.
- Independent native SDK templates: build/type checks and two browser end-to-end tests,
  including offline reading after plugin uninstall.
- Rust: 197 passed, 1 explicitly ignored live diagnostic.
- Windows builds passed twice. The final Web build passed and covers the last frontend-only
  storage-quota fix.
- Final whole-app unit suite: 1,133 files / 13,119 tests passed; 5 files / 17 tests skipped.
  The result is recorded in `.v2-artifacts/x2-unit-complete.log`.
- Complete TypeScript/Biome lint and repository format checks passed.

The explicit native live-list diagnostic failed on this Windows network: the system resolver
returns 198.18.0.156 for cdn.jsdelivr.net and 198.18.0.7 for ipv4only.arpa. These reserved addresses
remain blocked, and the diagnostic identifies this DNS condition separately. This Windows
observation is not an iOS test result. The user reported ClashMi in rule mode; TUN status is
unknown. That information does not establish Fake-IP DNS mode. No system/proxy settings were changed.

Independent compatibility prerelease `v0.3.0-x1` is published at
`cd622bafce63d58b42a6868ca9f000104865f8e9`. All nine downloaded assets match GitHub digests;
the source archive verifies both production signatures. The application lock pins the three
aggregate archives. The actual production-signed packages pass three Chromium and three WebKit
tests with AbortSignal.any unavailable. Remote live acceptance passed three sources per engine.
See https://github.com/WenHe233/readest-remote-plugins/actions/runs/39990089308.

Next, run the remote application/platform test build with `publish=false`. Remote platform builds
remain required checks. Application x2 publication must wait for iOS 17.0 cellular/IPv6-only device
verification. Existing x1 tags and assets remain immutable.

## Historical x1 implementation and verification

Build, verification, push and prerelease publication were authorized on 2026-10-23.
Publication remains gated by the local checks and the complete remote build matrix.

## Workspaces

- Default application: `../readest-remote`, branch `feat/external-plugins-v2`.
- Experimental application: this checkout, branch exp/network-sources.
- Independent compatibility plugins: ../readest-remote-plugins, branch exp/network-sources.
- Earlier default commits: worktree helper 18e70bb5e, release infrastructure fbe4248d6.
- Experimental includes helper changes and release infrastructure cherry-pick b60e2cf48.
- The default and experimental branches are pushed. Default changes contain only general CI/testing infrastructure;
  API 3, content services, readers, profile isolation and source UI are in the experimental tree.

## Implemented

- SDK API 3 over RPC 2, separate content capabilities, native text/comic templates, CLI,
  deterministic HTTP test host, and API 2 dictionary/library compatibility.
- Independent Legado/Venera QuickJS compatibility packages, raw source/source-list import,
  fixed-source replay tests, pinned source digests, license records and live diagnostics.
- Host-bound source instances, exact-origin grants, redirect/DNS policy, cancellation,
  encrypted cookies/credentials/private state, worker limits and permission revocation.
- Search/discovery, details, stable chapter snapshots and reading locators, lazy text/comic
  reading, favorites, manual update checks, explicit downloads and offline integrity checks.
- Experimental native identity and explicit browser storage profile. See
  ../experimental-web-profile.md for the separate-origin Web deployment requirement.
- Manual experimental workflow, fixed-SHA checks, immutable draft recovery and non-latest
  prereleases. Experimental release checks reject an unpinned compatibility engine lock.

## Verification

- Final Windows verification completed on 2026-10-23.
- Whole-app unit suite: 1,120 files and 13,061 tests passed; 5 files / 17 tests skipped.
- Whole Chromium suite: 95 files and 702 tests passed; 1 test skipped.
- Existing API 2 Kavita/Komga packages: 15 lifecycle, cache, UI and isolation tests passed
  without repackaging the old plugins.
- Complete application TypeScript/Biome lint and repository format check passed.
- Rust library: 191 tests passed. Rust fmt and Clippy passed after the final cancellation fix.
- SDK CLI: 4 tests passed, including strict type checks for both independent native templates
  and rejection of unsafe/non-semantic versions and reserved plugin identities.
- Release infrastructure and SDK CLI: 24 Node tests in the experiment and 14 release tests in the default checkout passed;
  workflow syntax passed actionlint.
- Compatibility engine source: 37 tests passed; optional live/library cases skipped in the ordinary unit run;
  TypeScript and modified script syntax checks passed.
- Signed compatibility-worker fixtures: Chromium 3 tests and WebKit 3 tests passed. The WebKit
  signature/legacy sandbox suite passed 17 tests. Development package checks are supplemented
  by tests of the exact production-signed release archives after the release lock is updated.
- Web profile subset: 957 unit tests and 87 Chromium tests passed, including actual IndexedDB,
  AES-GCM credential and OPFS isolation between same-origin stable/experimental data.
- Local live engine checks passed actual first-image download for MangaDex, Komiic and Comick,
  and visible chapter text for 酷我小说、阅友小说、书海阁. The plugin repository retains the timestamped
  .artifacts/compatibility-live.json report, including failed original candidates.
- The extension's complete dependency graph now passes TypeScript 5.9 and 7. Webpage conversion
  has a separate shared entry, so the extension no longer imports TXT/DOCX reader dependencies.
  Its production build runs this check before webpack; the build and 115 affected tests passed.
- Independently initialized native text/comic packages were built from the SDK archive and
  exercised through real signed Workers, search, favorites, downloads and offline opening
  after uninstall. Both tests passed without any compatibility package installed.
- The integration exposed and fixed host-only chapter slots leaking into strict RPC payloads.
  Offline unit fixtures now validate the actual request schema instead of accepting extra fields.
- WebView2: 130 native tests passed, 1 skipped, including signed compatibility Workers and
  experimental portable-profile isolation. The legacy portable test now checks the new profile
  and verifies that a stable settings marker remains untouched.
- Windows x64 NSIS and static Web builds passed. The final Windows rebuild includes the chapter
  projection fix. Production plugin signing and remote platform builds follow the SDK commit pin.

The test configuration now writes/loads explicit public CI fixture variables. It enables
cloud test cases without the self-hosted premium bypass. A novel-image failure fixture uses
a deterministic failed request instead of depending on public DNS. The TTS OPFS browser
fixture now clears its own experimental test directory. No product paywall or cloud behavior
was changed to satisfy these tests. Test environment files are restored after verification.

## Release sequence

1. SDK source is pinned to application commit `a0148875a4cb864440dee9af4765be715a151c5b`.
   Independent package preparation uses npm consistently; archives produced from the clean
   committed tree and local checkout have the same SHA-256 and include the SDK license.
2. Compatibility prerelease 0.2.0-x1 is published from `5c64d545563e588be402585eb7c9da4ab6ebc867`.
   All nine assets and the six-source live report were downloaded and checked against GitHub's
   SHA-256 digests. `external-plugins.lock.json` pins the source, SDK and example archives plus
   both provider identities and the production signer. Stable library package versions remain unchanged.
3. Production signed-package tests passed in Chromium and WebKit (three each). The published
   SDK archive matches the locally validated archive byte-for-byte. The native text/comic
   template build and offline-after-uninstall tests also passed with that final SDK archive.
4. Local native WebView2 acceptance passed. The full remote platform/19-artifact matrix and
   platform packaging checks remain publication gates.
5. Publish v0.12.12-x1 only after every release gate passes; prerelease=true, make_latest=false.

Do not stage baseline Foliate/Tauri/Turso submodule worktree patches as feature commits.
The experimental Android Kotlin paths are tracked despite their generated-tree location.
Test environment files are ignored and must be restored to their pre-test state when local
verification finishes.
