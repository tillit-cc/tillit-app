import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { TorProxy } from 'tor-proxy';
import type { TorHttpRequestConfig } from 'tor-proxy';

/**
 * Check if a URL is an .onion address.
 */
export function isOnionUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return hostname.endsWith('.onion');
  } catch {
    return url.includes('.onion');
  }
}

/**
 * Axios adapter that routes ALL requests through the native Tor SOCKS proxy.
 * Completely bypasses XMLHttpRequest and iOS App Transport Security.
 *
 * Used as `this.client.defaults.adapter = torAxiosAdapter` on Tor ApiService instances.
 * Since the entire ApiService is dedicated to one .onion server, every request goes through Tor.
 */
export async function torAxiosAdapter(config: AxiosRequestConfig): Promise<AxiosResponse> {
  const fullUrl = buildFullUrl(config);

  const torConfig: TorHttpRequestConfig = {
    url: fullUrl,
    method: (config.method?.toUpperCase() as TorHttpRequestConfig['method']) || 'GET',
    headers: flattenHeaders(config),
    body: config.data
      ? (typeof config.data === 'string' ? config.data : JSON.stringify(config.data))
      : undefined,
    // Hidden services need longer timeouts (circuit building + rendezvous)
    timeout: Math.max(config.timeout || 30000, 120000),
  };

  const result = await TorProxy.httpRequest(torConfig);

  let parsedData: any;
  if (config.responseType === 'arraybuffer') {
    parsedData = result.data;
  } else {
    try {
      parsedData = JSON.parse(result.data);
    } catch {
      parsedData = result.data;
    }
  }

  const response: AxiosResponse = {
    data: parsedData,
    status: result.status,
    statusText: result.status >= 200 && result.status < 300 ? 'OK' : 'Error',
    headers: result.headers,
    config: config as any,
    request: {},
  };

  // Mimic Axios behavior: throw for non-2xx if validateStatus says so
  const validateStatus = config.validateStatus || ((s: number) => s >= 200 && s < 300);
  if (!validateStatus(result.status)) {
    const error: any = new Error(`Request failed with status code ${result.status}`);
    error.config = config;
    error.response = response;
    error.isAxiosError = true;
    throw error;
  }

  return response;
}

function buildFullUrl(config: AxiosRequestConfig): string {
  const baseURL = config.baseURL || '';
  const url = config.url || '';

  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  return `${baseURL.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

/**
 * Flatten Axios headers (which can be AxiosHeaders object) into a plain Record.
 */
function flattenHeaders(config: AxiosRequestConfig): Record<string, string> | undefined {
  const headers = config.headers;
  if (!headers) return undefined;

  const flat: Record<string, string> = {};
  if (typeof headers.forEach === 'function') {
    // AxiosHeaders object
    (headers as any).forEach((value: string, key: string) => {
      flat[key] = value;
    });
  } else {
    // Plain object
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null) {
        flat[key] = String(value);
      }
    }
  }
  return Object.keys(flat).length > 0 ? flat : undefined;
}
