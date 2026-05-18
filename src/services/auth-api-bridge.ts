/**
 * Bridge between auth.store and server-registry.
 *
 * Breaks the require cycle: auth.store → server-registry → auth.store
 * by isolating the dependency on serverRegistry in this intermediate module.
 * auth.store imports this bridge instead of server-registry directly.
 */
import { serverRegistry } from './server-registry';
import { ApiService } from './api.service';
import * as SecureStore from 'expo-secure-store';

/**
 * Get the default server's API instance.
 * Falls back to creating a temporary ApiService if serverRegistry isn't loaded yet
 * (e.g. during loadStoredToken which runs before bootstrap).
 */
export function getDefaultApi(): ApiService {
  try {
    return serverRegistry.getApi(serverRegistry.getDefaultServerId());
  } catch {
    const apiUrl = process.env.EXPO_PUBLIC_API_URL || 'https://api.tillit.cc';
    return new ApiService(0, apiUrl);
  }
}

/**
 * Token key for the default server.
 * Must match the pattern used by ApiService: `token_server_{serverId}`.
 * Before serverRegistry is loaded, we try serverId=1 (auto-increment) and fallback to legacy.
 */
export async function getDefaultServerToken(): Promise<string | null> {
  try {
    const api = serverRegistry.getApi(serverRegistry.getDefaultServerId());
    return api.getToken();
  } catch {
    const token = await SecureStore.getItemAsync('token_server_1');
    if (token) return token;
    return SecureStore.getItemAsync('token_server_0');
  }
}

export async function clearDefaultServerToken(): Promise<void> {
  try {
    const api = serverRegistry.getApi(serverRegistry.getDefaultServerId());
    await api.clearToken();
  } catch {
    await SecureStore.deleteItemAsync('token_server_1').catch(() => {});
    await SecureStore.deleteItemAsync('token_server_0').catch(() => {});
  }
}

/**
 * Get the default server ID, or null if serverRegistry isn't loaded yet.
 */
export function getDefaultServerId(): number | null {
  try {
    return serverRegistry.getDefaultServerId();
  } catch {
    return null;
  }
}
