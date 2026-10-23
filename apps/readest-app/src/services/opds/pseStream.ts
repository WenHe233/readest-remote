import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { READEST_OPDS_USER_AGENT } from '@/services/constants';
import { useSettingsStore } from '@/store/settingsStore';
import {
  needsProxy,
  getProxiedURL,
  probeAuth,
  withOriginSuppressed,
} from '@/app/opds/utils/opdsReq';
import { normalizeCustomHeaders } from '@/utils/customHeaders';
import type { WidePagesOptions } from '@/utils/spread';
import { openPageStreamBook } from '@/libs/pageStream';
export { openPageStreamBook } from '@/libs/pageStream';
import type { BookFormat } from '@/types/book';
import type { BookDoc } from '@/libs/document';

export const PSE_SCHEME = 'pse://';

export interface PseStreamData {
  url: string;
  catalogId: string;
  count: number;
  title: string;
  author: string;
}

export const isPseStreamFileName = (name: string): boolean => name.startsWith(PSE_SCHEME);

export const buildPseStreamFileName = (data: PseStreamData): string =>
  PSE_SCHEME + encodeURIComponent(JSON.stringify(data));

export const parsePseStreamFileName = (name: string): PseStreamData =>
  JSON.parse(decodeURIComponent(name.replace(PSE_SCHEME, '')));

const PAGE_NUMBER_PATTERN = /%7BpageNumber%7D|\{pageNumber\}/gi;
const MAX_WIDTH_PATTERN = /%7BmaxWidth%7D|\{maxWidth\}/gi;
const DEFAULT_MAX_WIDTH = '2000';

export const createPseStreamPageLoader = (data: PseStreamData) => {
  const settings = useSettingsStore.getState().settings;
  const catalog = settings.opdsCatalogs?.find((c) => c.id === data.catalogId);
  const username = catalog?.username || '';
  const password = catalog?.password || '';
  const customHeaders = normalizeCustomHeaders(catalog?.customHeaders);
  let authHeaderPromise: Promise<string | null> | null = null;

  return async (pageIndex: number): Promise<Blob> => {
    let url = data.url.replace(PAGE_NUMBER_PATTERN, pageIndex.toString());
    url = url.replace(MAX_WIDTH_PATTERN, DEFAULT_MAX_WIDTH);
    const useProxy = needsProxy(url);

    if (!authHeaderPromise) {
      authHeaderPromise =
        username || password
          ? probeAuth(url, username, password, useProxy, customHeaders)
          : Promise.resolve(null);
    }
    const authHeader = await authHeaderPromise;

    const fetchURL = useProxy ? getProxiedURL(url, authHeader || '', true, customHeaders) : url;
    const headers: Record<string, string> = withOriginSuppressed({
      'User-Agent': READEST_OPDS_USER_AGENT,
      ...(!useProxy ? customHeaders : {}),
      ...(!useProxy && authHeader ? { Authorization: authHeader } : {}),
    });
    const fetch = isTauriAppPlatform() ? tauriFetch : window.fetch;
    const res = await fetch(fetchURL, {
      headers,
      danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch page ${pageIndex}: ${res.statusText}`);
    }
    return res.blob();
  };
};

export const openPseStreamBook = async (
  data: PseStreamData,
  widePages?: WidePagesOptions,
): Promise<{ book: BookDoc; format: BookFormat }> => {
  return openPageStreamBook(data, createPseStreamPageLoader(data), widePages);
};
