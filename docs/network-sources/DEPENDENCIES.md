# Experimental framework dependencies

New application runtime dependencies are fixed in `apps/readest-app/package.json`
and the workspace lockfile:

| Package | Version | License | Purpose |
| --- | --- | --- | --- |
| `tldts` | 7.0.30 | MIT | Public/private suffix checks before accepting parent-domain cookies |
| `@noble/curves` | 1.9.7 | MIT | Strict Ed25519 fallback when WebCrypto reports `NotSupportedError` |

The signature fallback uses `zip215: false`. A supported WebCrypto implementation
returning an invalid signature is never retried through another verifier.

Generated SDK projects pin esbuild 0.28.1 (MIT), TypeScript 5.9.3 (Apache-2.0) and
`@zip.js/zip.js` 2.8.26 (BSD-3-Clause). These are development tools; native plugins
do not depend on QuickJS. Existing SDK Zod use remains unchanged.

QuickJS, HTML/XML/JSONPath parsers, encoding and legacy cipher helpers belong to
the separate compatibility plugin repository. Its `COMPATIBILITY.md` lists pinned
versions, licenses and fixture redistribution exclusions. Imported source inputs
are not installed as trusted package code, and their licenses do not transfer to
the independently written compatibility engine.
