# Experimental source compatibility

This file records observed evidence, not universal format compatibility. A successful
import is not a successful reading test. HTTP replay and public-network checks are separate.

## Upstream fixtures

- Venera source files: `venera-app/venera-configs` at
  `a04e05591f7832f7166d6660546613c114d6738a`.
- Legado source list: `XIU2/Yuedu` at
  `426b24f59aa763ee0f2d9cc094612d2ef42c8293`.
- Additional live Legado sample: `speauty/legado.sources` at
  `ff3e1928f575fb235a50cc54f286fbc1d1babe90`, `sources/active/shuhaige.json`.
- Fixture SHA-256 inventory and engine tests live with the compatibility plugins.

## Current evidence

| Engine | Fixed-response replay | Public network |
| --- | --- | --- |
| Venera | Original MangaDex, Baozi and Komiic sources pass search/details/directory/content replay | MangaDex, Komiic and Comick passed through first image download in development validation |
| Legado | Original 得奇小说网、天天看小说、手机小说 pass search/details/directory/content replay | 酷我小说、阅友小说、书海阁 passed search/details/directory through nonempty visible chapter text |

Public sample failures include HTTP 403, unavailable TLS connections, empty site results
and sources requiring browser challenges. They are not counted as compatible reads.
The live report is retained with the plugin repository. It checks downloaded image bytes
and image MIME for comics, and non-whitespace visible text for novels; merely returning
an image URL or an empty HTML element does not pass.

## Explicitly unsupported in x1

WebView content extraction/challenges, arbitrary Java/Android classes, complex pixel
transformations, remote comment/favorite writes and fork-specific APIs are outside the x1
compatibility contract. Providers must return a diagnostic for an unsupported operation.

## Release gate

Before publishing x1, run the independent plugin regression suite, signed-worker browser
tests, native/reader checks and live search-to-content tests for at least three sources per
engine. Record the actual source revision and failure stage; never count replay or empty
content toward the live gate. Local live evidence now meets the three-per-engine count;
cross-platform installer validation remains a release gate. Local WebView2 compatibility
Worker tests passed alongside Chromium and WebKit; final production packages are verified again
after the independent compatibility release is pinned.
