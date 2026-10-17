# Readest Remote 0.12.12-r2

This release fixes external-plugin management, narrow-screen settings, library
synchronization and full-book search during remote reading.

- Plugin installation and update review now compare semantic versions. An
  installed version cannot be installed again through the catalog or approval
  dialog. Repository refresh reports whether installed plugins have updates.
- Plugin dialogs open above Settings without clipping. Narrow cards stack
  multi-action rows and connection fields; category labels and long signer
  fingerprints stay readable. Escape and Back close the top dialog only.
- Saving a library connection starts a background task and closes the form.
  The library and connection settings show catalog/cover progress and provide
  cancellation and retry. Tasks continue while navigating or reading within
  the running app. Exiting the app does not preserve a resumable task.
- Reader search uses the already-open document, including Kavita byte-range
  EPUB/PDF and Komga resource-streamed EPUB. It no longer requires a complete
  local original. Searches retain chapter progress, cached text, result links
  and highlights. Image-only books report that they have no searchable text.
- Successive queries serialize index writes, and closing search never closes
  the reader's borrowed document.

The first full-book search may read text from every chapter or PDF page over
the network. Search does not create an offline original automatically.

The application identity remains `io.github.wenhe233.readestremote`, with the
`readest-remote` protocol. Android versionCode and Apple bundleVersion are
`12012002`. Existing signed Kavita/Komga 0.1.1 plugins remain compatible.
Readest Cloud remains disabled; server reading-progress sync is unchanged.

The release retains the r1 platform matrix: Windows x64/ARM64 installers and
portable executables, Linux x64/ARM64 AppImage/DEB, universal macOS DMG,
Android universal/ARM64 APK, unsigned iOS IPA, Web and companion packages,
and signed plugin source/SDK/examples. Checksums accompany the artifacts.

For the initial V1 profile upgrade and backup behavior, see
[the r1 upgrade notes](RELEASE_R1.md). r1-to-r2 uses the existing profile.
Build configuration and packaging are described in [CI.md](CI.md).
