import { createClient } from '@supabase/supabase-js';
import { getRuntimeConfig } from '@/services/runtimeConfig';
import { isReadestCloudAvailable } from '@/services/readestCloud';
import { profileLocalStorage, SUPABASE_AUTH_STORAGE_NAME } from '@/services/browserProfile';

const cloudEnabled = isReadestCloudAvailable();
const profileAuth = {
  storage: profileLocalStorage,
  // Also separates Supabase's cross-tab broadcast channel and refresh locks.
  storageKey: SUPABASE_AUTH_STORAGE_NAME,
};
const disabledOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: {
    fetch: async (): Promise<Response> => {
      return new Response(JSON.stringify({ message: 'Readest Cloud is disabled in this build' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  },
};

const supabaseUrl = !cloudEnabled
  ? 'https://readest-cloud-disabled.invalid'
  : getRuntimeConfig()?.supabaseUrl ||
    process.env['SUPABASE_URL'] ||
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ||
    atob(process.env['NEXT_PUBLIC_DEFAULT_SUPABASE_URL_BASE64']!);
const supabaseAnonKey = !cloudEnabled
  ? 'readest-cloud-disabled'
  : getRuntimeConfig()?.supabaseAnonKey ||
    process.env['SUPABASE_ANON_KEY'] ||
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ||
    atob(process.env['NEXT_PUBLIC_DEFAULT_SUPABASE_KEY_BASE64']!);

export const supabase = createClient(
  supabaseUrl,
  supabaseAnonKey,
  cloudEnabled ? { auth: profileAuth } : disabledOptions,
);

export const createSupabaseClient = (accessToken?: string) => {
  if (!cloudEnabled) return createClient(supabaseUrl, supabaseAnonKey, disabledOptions);
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: profileAuth,
    global: {
      headers: accessToken
        ? {
            Authorization: `Bearer ${accessToken}`,
          }
        : {},
    },
  });
};

export const createSupabaseAdminClient = () => {
  if (!cloudEnabled) return createClient(supabaseUrl, supabaseAnonKey, disabledOptions);
  const supabaseAdminKey = process.env['SUPABASE_ADMIN_KEY'] || '';
  return createClient(supabaseUrl, supabaseAdminKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
};
