# Self-hosted encrypted connection sync

The public `0.12.12-r1` build disables Readest Cloud. To enable it in your own
build, set the deployment variables below and run
`node scripts/ci/configure-build.mjs --cloud` before building.

Deploy the backend from this branch and apply the repository's database
migrations, including `026_replica_plugin_connections.sql`. This adds
`plugin_connection` to the existing Replica system; it does not require a second
sync service. The official hosted Readest service is outside this deployment.

The existing Docker entrypoint applies migrations in order. Keep the migration
hook as LF on Windows; `.gitattributes` pins shell-script line endings. Back up
an existing database before deploying any schema migration. Use the existing
Docker deployment guide for PostgreSQL, auth, API gateway and object storage.

Configure the desktop build with the self-hosted deployment's
`NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_SUPABASE_URL` and public
`NEXT_PUBLIC_SUPABASE_ANON_KEY`. The backend also needs its existing server-only
Supabase configuration. Never compile the service-role key into the frontend.
For two concurrent local development servers, set `READEST_NEXT_DIST_DIR` to
different paths (for example `.next-v2-tauri` for the desktop frontend).
Add `readest-remote://auth-callback` and the required callback paths to your auth
server's redirect allowlist. The application retains the V1 scheme.

Enable **Plugin connections** in Manage Sync. To include credentials, enable
the existing credentials category and unlock the existing sync passphrase.
Metadata can sync while the passphrase is locked; credential fields are omitted
in that case. **Sync connection** republishes a previously local connection.

The replicated fields are the connection UUID, plugin ID, signer fingerprint,
source ID, display name, server URL, non-secret configuration, library selection,
credential slot names and timestamps. Credentials are serialized together and
encrypted through the upstream PBKDF2/AES-GCM middleware. The API rejects a
plaintext `credentials` envelope. Merge clocks, tombstones and reincarnation
use the upstream Replica protocol.

Local endpoint overrides, TLS exceptions, caches, complete offline books,
installed plugin packages, and execution permissions are device-local. Receiving
a connection does not install code or grant permissions: the user must install
the matching signer and approve it on the new device. A connection UUID cannot
be reassigned to a different plugin or signer through sync.

On decryption failure the incoming credential field is omitted; valid local
credentials remain intact. An empty value does not silently replace an
undecryptable field. Deletion uses the standard remove-wins tombstone path.
Keep the same passphrase on your devices and use the upstream recovery controls
when rotating or resetting encryption keys.

The integration test exercises the actual API and PostgreSQL migration, including
plaintext rejection. Native acceptance additionally uses separately compiled
Windows profiles ending in `.verification.a` and `.verification.b`, separate
WebView data and separate Credential Manager namespaces. It checks encrypted
round-trip, restart persistence, wrong passphrase, local overrides, installation
and permission independence, field merge and deletion. See `STATUS.md`.

The provided local verification build uses the test self-hosted endpoints on
ports 18000 (auth/database gateway) and 3003 (Readest API). Change the public
deployment variables and rebuild when connecting to your own deployment.
Plugin libraries themselves can always be configured through Settings.
