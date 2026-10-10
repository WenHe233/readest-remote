import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const test = process.argv.includes('--test');
const defaults = test ? {
  NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:3003',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:18000',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'ci-public-anon-key',
} : {};
const values = {};
for (const name of ['NEXT_PUBLIC_API_BASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']) {
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
  NEXT_PUBLIC_SELF_HOSTED: 'true',
  NEXT_PUBLIC_DEFAULT_POSTHOG_KEY_BASE64: '',
  NEXT_PUBLIC_POSTHOG_KEY: '',
});
writeFileSync(resolve('apps/readest-app/.env.local'), Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n');
console.log(`Configured ${test ? 'isolated CI test' : 'self-hosted'} frontend variables (public values only).`);
