# Local implementation and verification

Build, verification, push and prerelease publication were authorized on 2026-10-23.
Publication remains gated by the local checks and the complete remote build matrix.

## Workspaces

- Default application: `../readest-remote`, branch `feat/external-plugins-v2`.
- Experimental application: this checkout, branch exp/network-sources.
- Independent compatibility plugins: ../readest-remote-plugins, branch exp/network-sources.
- Earlier default commits: worktree helper 18e70bb5e, release infrastructure fbe4248d6.
- Experimental includes helper changes and release infrastructure cherry-pick b60e2cf48.
- Later changes remain local. Default changes contain only general CI/testing infrastructure;
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
- Release infrastructure: 19 Node tests in the experiment and 14 in the default checkout passed;
  workflow syntax passed actionlint.
- Compatibility engine source: 26 tests passed; 2 configured library integration tests skipped;
  TypeScript and modified script syntax checks passed.
- Signed compatibility-worker fixtures: Chromium 3 tests and WebKit 3 tests passed. The WebKit
  signature/legacy sandbox suite passed 17 tests. These use development artifacts generated
  before the user paused building; existing dist/ is not a final-source release artifact.
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
was changed to satisfy these tests. Test environment files were restored after verification.

## Release sequence

1. Commit/push the reviewed SDK source, then replace the compatibility repository's explicit
   SDK_SOURCE.revision: null with that real immutable commit.
2. Produce and verify the compatibility prerelease 0.2.0-x1, retaining stable library package
   versions. Update external-plugins.lock.json with the real release commit and asset hashes.
3. Build final SDK/plugin/app artifacts from those exact sources. Re-run signed-package tests
   on those final artifacts; cached development packages are not release evidence.
4. Run native WebView2 acceptance and the full platform/19-artifact matrix, including parallel
   installation, upgrade and removal. These require application builds and remain unexecuted.
5. Publish v0.12.12-x1 only after every release gate passes; prerelease=true, make_latest=false.

Do not stage baseline Foliate/Tauri/Turso submodule worktree patches as feature commits.
The new experimental Android Kotlin paths use intent-to-add so their ignored generated-tree
locations remain visible in the local diff. Test environment files are ignored and must be
restored to their pre-test state when local verification finishes.
