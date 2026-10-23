import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const test = process.argv.includes('--test');
const cloud = test || process.argv.includes('--cloud');
const defaults = test ? {
  NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:3003',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:18000',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'ci-public-anon-key',
} : {};
const values = {};
for (const name of ['NEXT_PUBLIC_API_BASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']) {
  if (!cloud) { values[name] = ''; continue; }
  const value = defaults[name] || process.env[name];
  if (!value || /[\r\n]/.test(value)) throw new Error(`Configure the ${name} repository variable`);
  if (name.endsWith('_URL')) {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(`Invalid ${name}`);
  }
  values[name] = value;
}
const key = values.NEXT_PUBLIC_SUPABASE_ANON_KEY;
let claims;
try { claims = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString()); } catch { /* publishable keys need not be JWTs */ }
if (key.startsWith('sb_secret_') || claims?.role === 'service_role') throw new Error('A server-only Supabase key cannot be compiled into the app');
Object.assign(values, {
  NEXT_PUBLIC_READEST_CLOUD_ENABLED: String(cloud),
  ...(!cloud ? { NEXT_PUBLIC_DEFAULT_SUPABASE_URL_BASE64: '', NEXT_PUBLIC_DEFAULT_SUPABASE_KEY_BASE64: '' } : {}),
  // Test the hosted feature gates; deployment builds retain self-hosted behavior.
  NEXT_PUBLIC_SELF_HOSTED: String(!test),
  NEXT_PUBLIC_DEFAULT_POSTHOG_KEY_BASE64: '',
  NEXT_PUBLIC_POSTHOG_KEY: '',
});
const content = Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n';
writeFileSync(resolve('apps/readest-app/.env.local'), content);
if (test) writeFileSync(resolve('apps/readest-app/.env.test.local'), content);
console.log(`Configured ${test ? 'isolated CI test' : cloud ? 'self-hosted' : 'cloud-disabled release'} frontend variables (public values only).`);
