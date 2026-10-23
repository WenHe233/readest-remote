# Experimental Web data profile

The experimental app uses the fixed profile `io.github.wenhe233.readestremote.experimental`. The profile does not contain an `xN` release number, so experimental upgrades retain their own data. Starting the experimental app does not read or migrate the regular app's data.

`apps/readest-app/src/services/browserProfile.ts` supplies explicit storage facades and names. Browser globals and `Storage.prototype` remain unchanged. Application code uses `profileLocalStorage` and `profileSessionStorage`; enumeration and `clear()` affect only keys in that profile. Cross-tab storage events use the physical key from `profileStorageKey()`.

The profile covers:

- Settings, language, theme, library preferences, reading positions, OAuth redirect state and session tokens.
- IndexedDB file storage (`AppFileSystem`), installed plugin packages, plugin credentials and source state, AI history/indexes, and translation caches.
- OPFS SQLite databases and journals, including reading statistics, plus TTS pack directories.
- Supabase sessions, refresh locks and broadcast channels; PostHog persistence and consent records.
- Service worker precache and runtime caches. Legacy Serwist cache cleanup is explicitly disabled because its scope-based matching can include another app's caches. The app does not unregister other service workers or enumerate and delete origin-wide caches.

The companion experimental browser extension reads the exported `SUPABASE_AUTH_STORAGE_KEY` only. It does not restore a regular app's Supabase session.

Native app filesystem locations and OS credential stores continue to use the experimental application identity configured by the native build. The browser profile also protects the WebView's IndexedDB and browser storage without changing native filesystem paths.

## Deployment boundary

The current Web build uses root application routes, a root manifest and `/sw.js`. Deploy the stable and experimental builds on separate origins. Two builds cannot independently own the same service worker registration at the same origin and scope. Supporting distinct paths on one origin additionally requires coordinated base paths, asset URLs, manifests, OAuth callbacks and non-overlapping service worker scopes; the storage profile does not configure those routes.

Data isolation is tested even when both profiles share one browser origin. Separate deployment origins therefore supplement the explicit data profile, rather than replacing it. Browser-wide user actions such as clearing all site data still apply to the whole origin.

## Regression tests

- `src/__tests__/services/browser-profile.test.ts`: isolated key enumeration/cleanup and server-side behavior.
- `src/__tests__/services/browser-profile.browser.test.ts`: real Chromium IndexedDB, AES-GCM credentials, OPFS databases/journals and TTS packs, including stable records with identical logical names.
- Existing persistence, shortcut, OAuth, theme, reading position and library tests use the explicit profile facade. Browser primitives used to simulate `StorageEvent` or unavailable storage remain native.

Run from `apps/readest-app`:

```sh
pnpm test --run src/__tests__/services/browser-profile.test.ts
pnpm test:browser src/__tests__/services/browser-profile.browser.test.ts src/__tests__/services/web-app-service.browser.test.ts
```
